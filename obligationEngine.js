// Obligation Engine — derives VAT/CT obligations from client compliance
// settings and synchronizes them into compliance_obligations + compliance_tasks.
//
// Design:
//   • Pure period math lives in intelligence.js.
//   • This module does the I/O: read clients (in-memory tracker), compute
//     periods forward N months, upsert into compliance_obligations
//     (deduped by source_key), then ensure a compliance_task exists per
//     obligation that is within its lead-time window.
//   • Idempotent. Safe to run repeatedly. Re-running with changed client
//     settings overwrites future obligations via deleteForClient() + upsert.

const intelligence = require('./intelligence');
const { obligations } = require('./obligations');
const compliance = require('./compliance');
const { tracker, activity, store } = require('./database');
// Lazy require to avoid circular deps at module-load.
function workflowService() { return require('./services/workflowService'); }

const DAY = 24 * 60 * 60 * 1000;
const FORWARD_MONTHS = parseInt(process.env.OBLIGATION_FORWARD_MONTHS || '12', 10);

function resolveAssignee(name) {
  if (!name) return { id: null, name: null };
  const u = (store.users || []).find(u => u.name === name && u.active === 1);
  return u ? { id: u.id, name: u.name } : { id: null, name };
}

function buildSourceKey(clientId, type, periodLabel) {
  return `obl:${clientId}:${type}:${periodLabel}`;
}

// Map obligation_type → compliance_task_type
function taskTypeFor(obligationType) {
  return ({
    VAT_Return: 'VAT_Filing',
    CT_Return: 'CT_Filing',
    VAT_Registration: 'VAT_Registration',
    CT_Registration: 'CT_Registration',
    VAT_Amendment: 'Amendment',
    CT_Amendment: 'Amendment',
    VAT_Refund: 'Refund',
    CT_Refund: 'Refund',
    Audit: 'Audit',
    Management_Report: 'Management_Report',
    Review: 'Review'
  })[obligationType] || 'Other';
}

// Lead window: how many days before filing_deadline a task should exist.
function leadDaysFor(obligationType) {
  return ({
    VAT_Return: 21, CT_Return: 45,
    VAT_Registration: 14, CT_Registration: 14,
    VAT_Amendment: 14, CT_Amendment: 14,
    VAT_Refund: 14, CT_Refund: 14,
    Audit: 30, Management_Report: 7, Review: 3
  })[obligationType] || 14;
}

async function syncObligationsForClient(client, opts = {}) {
  if (!client) return { upserted: 0 };
  const today = new Date();
  const toDate = new Date(today.getTime() + FORWARD_MONTHS * 30 * DAY);
  const out = [];

  // VAT
  if (client.vatRegistrationDate) {
    const periods = intelligence.vatPeriodsBetween(
      client.vatRegistrationDate,
      client.vatFrequency || 'Quarterly',
      today, toDate
    );
    for (const p of periods) {
      const sourceKey = buildSourceKey(client.id, 'VAT_Return', p.period_label);
      const row = await obligations.upsert({
        clientId: client.id, clientName: client.name,
        obligationType: 'VAT_Return',
        periodLabel: p.period_label,
        periodStart: p.period_start, periodEnd: p.period_end,
        filingDeadline: p.filing_deadline,
        paymentDeadline: p.payment_deadline,
        sourceKey,
        metadata: { frequency: client.vatFrequency || 'Quarterly' }
      });
      out.push(row);
    }
  }

  // CT
  if (client.ctRegistrationDate || client.incorporationDate || client.financialYearEnd) {
    const periods = intelligence.ctPeriodsBetween(
      client.incorporationDate || client.ctRegistrationDate || null,
      client.financialYearEnd || '12-31',
      today, toDate
    );
    for (const p of periods) {
      const sourceKey = buildSourceKey(client.id, 'CT_Return', p.period_label);
      const row = await obligations.upsert({
        clientId: client.id, clientName: client.name,
        obligationType: 'CT_Return',
        periodLabel: p.period_label,
        periodStart: p.period_start, periodEnd: p.period_end,
        filingDeadline: p.filing_deadline,
        paymentDeadline: p.payment_deadline,
        sourceKey,
        metadata: Object.assign({ fyEnd: client.financialYearEnd || '12-31' }, p.metadata || {})
      });
      out.push(row);
    }
  }

  return { upserted: out.length, obligations: out };
}

// Walk obligations within their lead window and ensure a task exists for each.
async function ensureTasksForObligations(client, obligationRows) {
  let created = 0;
  for (const o of obligationRows) {
    const lead = leadDaysFor(o.obligation_type);
    const deadline = new Date(o.filing_deadline);
    const windowStart = new Date(deadline.getTime() - lead * DAY);
    if (windowStart > new Date()) continue; // not yet in lead window

    const sourceKey = `task:obl:${o.id}`;
    const existing = await compliance.tasks.findBySourceKey(sourceKey);
    if (existing) continue;

    const assignee = resolveAssignee(client.assignedTeam);
    const dueDate = new Date(deadline.getTime() - 1 * DAY).toISOString().slice(0, 10);

    await compliance.tasks.create({
      clientId: client.id,
      clientName: client.name,
      taskType: taskTypeFor(o.obligation_type),
      title: o.obligation_type.replace(/_/g, ' ') + ' ' + o.period_label,
      assignedUserId: assignee.id,
      assignedUserName: assignee.name,
      dueDate,
      complianceDeadline: o.filing_deadline,
      source: 'obligation',
      sourceKey,
      metadata: { obligation_id: o.id, period_label: o.period_label }
    });
    // Re-fetch the created task to set obligation_id explicitly.
    const t = await compliance.tasks.findBySourceKey(sourceKey);
    if (t && !t.obligation_id) {
      try {
        await compliance.tasks.update(t.id, {
          obligation_id: o.id,
          target_completion_date: new Date(deadline.getTime() - 3 * DAY).toISOString().slice(0,10),
          target_start_date: new Date(windowStart).toISOString().slice(0,10)
        });
      } catch (_) {}
    }
    // Phase 4 minimal: auto-start a workflow instance for VAT/CT filing obligations.
    if (o.obligation_type === 'VAT_Return' || o.obligation_type === 'CT_Return') {
      try {
        await workflowService().startWorkflow({
          clientId: client.id, clientName: client.name,
          workflowType: o.obligation_type === 'VAT_Return' ? 'VAT_Filing' : 'CT_Filing',
          periodLabel: o.period_label,
          obligationId: o.id,
          taskId: t ? t.id : null
        });
      } catch (e) { console.error('[workflow] auto-start:', e.message); }
    }
    created++;
  }
  return created;
}

async function regenerateForClient(clientId) {
  const { clients } = tracker.getData();
  const client = (clients || []).find(c => String(c.id) === String(clientId));
  if (!client) return { error: 'unknown_client' };
  // Drop future, non-filed obligations so changes to settings take effect.
  await obligations.deleteForClient(client.id, new Date().toISOString().slice(0, 10));
  const { obligations: rows } = await syncObligationsForClient(client);
  const created = await ensureTasksForObligations(client, rows);
  return { obligations: rows.length, tasksCreated: created };
}

async function runFullSweep() {
  const { clients } = tracker.getData();
  let oblCount = 0, taskCount = 0;
  for (const c of (clients || [])) {
    const { obligations: rows } = await syncObligationsForClient(c);
    oblCount += rows.length;
    taskCount += await ensureTasksForObligations(c, rows);
  }
  if (oblCount || taskCount) {
    activity.log(0, 'system', 'obligations_synced',
      `Synced ${oblCount} obligations, created ${taskCount} task(s) across ${(clients || []).length} client(s)`);
  }
  return { obligations: oblCount, tasksCreated: taskCount, clients: (clients || []).length };
}

function startScheduler() {
  if (process.env.OBLIGATION_ENGINE_ENABLED === 'false') return;
  const hours = parseFloat(process.env.OBLIGATION_SWEEP_HOURS || '24');
  setTimeout(() => runFullSweep().catch(e => console.error('[obligationEngine] sweep:', e.message)), 8000);
  setInterval(() => runFullSweep().catch(e => console.error('[obligationEngine] sweep:', e.message)), hours * 60 * 60 * 1000);
}

module.exports = { syncObligationsForClient, ensureTasksForObligations, regenerateForClient, runFullSweep, startScheduler };
