// Obligation Engine — derives VAT/CT obligations from client compliance
// settings and synchronizes them into compliance_obligations + compliance_tasks.
//
// Design:
//   • Period derivation lives in services/clientShape.js, which translates the
//     nested client record the UI maintains into concrete obligations. It used
//     to read flat fields (client.vatRegistrationDate, client.financialYearEnd)
//     that no client has ever had, so every sweep returned zero.
//   • This module does the I/O: read clients (in-memory tracker), upsert into
//     compliance_obligations (deduped by source_key), then ensure a
//     compliance_task exists per obligation inside its lead-time window —
//     adopting a task the rule-based generator already made rather than
//     creating a second copy of it.
//   • Idempotent. Safe to run repeatedly. Re-running with changed client
//     settings overwrites future obligations via deleteForClient() + upsert.

const { obligations } = require('./obligations');
const compliance = require('./compliance');
const shape = require('./services/clientShape');
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
  const out = [];

  // Derive the client's real obligations from the record the UI maintains.
  // See services/clientShape.js for why this goes through an adapter instead of
  // reading client.vatRegistrationDate / client.financialYearEnd directly —
  // those fields don't exist on any client and never did.
  const derived = shape.allObligations(client, {
    today: opts.today || new Date(),
    forwardMonths: FORWARD_MONTHS
  });

  for (const p of derived) {
    const sourceKey = buildSourceKey(client.id, p.obligationType, p.periodLabel);
    const row = await obligations.upsert({
      clientId: client.id, clientName: client.name,
      obligationType: p.obligationType,
      periodLabel: p.periodLabel,
      periodStart: p.periodStart, periodEnd: p.periodEnd,
      filingDeadline: p.filingDeadline,
      paymentDeadline: p.paymentDeadline,
      status: p.status,
      sourceKey,
      metadata: p.metadata || {}
    });
    out.push(row);
  }

  return { upserted: out.length, obligations: out };
}

// Walk obligations within their lead window and ensure a task exists for each.
//
// Tasks can arrive from two places: the rule-based generator in taskEngine
// (source 'generator', key 'gen:<client>:<type>:<period>') and from here
// (source 'obligation', key 'task:obl:<id>'). The two key schemes can't see
// each other, so without a guard the first obligation sweep would create a
// second copy of every task the generator already made. Match on what actually
// identifies the work — same client, same task type, same statutory deadline —
// and adopt the existing task instead of duplicating it.
async function ensureTasksForObligations(client, obligationRows) {
  let created = 0, adopted = 0;

  // One query per client, reused across that client's obligations.
  let existingForClient = null;
  async function openTasksForClient() {
    if (existingForClient) return existingForClient;
    try {
      existingForClient = await compliance.tasks.list({ clientId: client.id, limit: 1000 }) || [];
    } catch (e) {
      console.error('[obligationEngine] task lookup:', e.message);
      existingForClient = [];
    }
    return existingForClient;
  }

  for (const o of obligationRows) {
    const lead = leadDaysFor(o.obligation_type);
    const deadline = new Date(o.filing_deadline);
    const windowStart = new Date(deadline.getTime() - lead * DAY);
    if (windowStart > new Date()) continue; // not yet in lead window

    const sourceKey = `task:obl:${o.id}`;
    const existing = await compliance.tasks.findBySourceKey(sourceKey);
    if (existing) continue;

    // Already covered by a task from the other source? Link it to this
    // obligation so the period label and target dates aren't lost, then move on.
    const wantType = taskTypeFor(o.obligation_type);
    const dupe = (await openTasksForClient()).find(t =>
      t.task_type === wantType &&
      t.compliance_deadline === o.filing_deadline &&
      t.status !== 'completed'
    );
    if (dupe) {
      if (!dupe.obligation_id) {
        try {
          await compliance.tasks.update(dupe.id, {
            obligation_id: o.id,
            metadata: Object.assign({}, dupe.metadata || {}, {
              obligation_id: o.id, period_label: o.period_label, adopted: true
            })
          });
        } catch (e) { console.error('[obligationEngine] adopt:', e.message); }
      }
      adopted++;
      continue;
    }

    const assignee = resolveAssignee(client.assignedTeam);
    const dueDate = new Date(deadline.getTime() - 1 * DAY).toISOString().slice(0, 10);

    // Keep the in-sweep cache honest so two obligations sharing a deadline
    // (same type, e.g. a corrected period) can't both create a task.
    if (existingForClient) {
      existingForClient.push({
        task_type: wantType, compliance_deadline: o.filing_deadline,
        status: 'not_started', obligation_id: o.id
      });
    }

    await compliance.tasks.create({
      clientId: client.id,
      clientName: client.name,
      taskType: wantType,
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
  return { created, adopted };
}

async function regenerateForClient(clientId) {
  const { clients } = tracker.getData();
  const client = (clients || []).find(c => String(c.id) === String(clientId));
  if (!client) return { error: 'unknown_client' };
  // Drop future, non-filed obligations so changes to settings take effect.
  await obligations.deleteForClient(client.id, new Date().toISOString().slice(0, 10));
  const { obligations: rows } = await syncObligationsForClient(client);
  const { created, adopted } = await ensureTasksForObligations(client, rows);
  return { obligations: rows.length, tasksCreated: created, tasksAdopted: adopted };
}

async function runFullSweep() {
  const { clients } = tracker.getData();
  let oblCount = 0, taskCount = 0, adoptCount = 0;
  for (const c of (clients || [])) {
    const { obligations: rows } = await syncObligationsForClient(c);
    oblCount += rows.length;
    const r = await ensureTasksForObligations(c, rows);
    taskCount += r.created;
    adoptCount += r.adopted;
  }
  // Log every sweep, including the empty ones. The silent zero-result sweep is
  // exactly what hid this engine being broken for seven weeks.
  activity.log(0, 'system', 'obligations_synced',
    `Synced ${oblCount} obligation(s), created ${taskCount} task(s), linked ${adoptCount} existing across ${(clients || []).length} client(s)`);
  console.log(`[obligationEngine] sweep: ${oblCount} obligations, ${taskCount} tasks created, ${adoptCount} adopted, ${(clients || []).length} clients`);
  return {
    obligations: oblCount, tasksCreated: taskCount,
    tasksAdopted: adoptCount, clients: (clients || []).length
  };
}

function startScheduler() {
  if (process.env.OBLIGATION_ENGINE_ENABLED === 'false') return;
  const hours = parseFloat(process.env.OBLIGATION_SWEEP_HOURS || '24');
  setTimeout(() => runFullSweep().catch(e => console.error('[obligationEngine] sweep:', e.message)), 8000);
  setInterval(() => runFullSweep().catch(e => console.error('[obligationEngine] sweep:', e.message)), hours * 60 * 60 * 1000);
}

module.exports = { syncObligationsForClient, ensureTasksForObligations, regenerateForClient, runFullSweep, startScheduler };
