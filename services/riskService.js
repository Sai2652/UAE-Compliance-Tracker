// Risk Service — runs 10 detectors over current state and emits a uniform
// findings list. Findings drive client escalation scores, the Risk Center,
// the Action Center, the daily briefing, and bottleneck analysis.
//
// Detectors are pure functions; the registry below makes adding a new one
// trivial. Heavy data fetches are batched once at the top of `runAll()` so
// each detector iterates in-memory.

const repos = require('../repositories');
const readinessService = require('./readinessService');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d)  { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }
function daysUntil(d){ return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function isOpen(t)   { return t.status !== 'completed'; }

// ---------- Detectors ----------
// Each detector receives { tasks, docs, readiness, cfg } and returns [findings].

function detectOverdue({ tasks, cfg }) {
  return tasks.filter(t => isOpen(t) && t.due_date && new Date(t.due_date).getTime() < Date.now()).map(t => {
    const od = -daysUntil(t.due_date);
    const level = od >= cfg.risk_overdue_critical_days ? 'critical' : od >= 3 ? 'high' : 'medium';
    return finding('overdue', level, t, `${od} day(s) overdue`, 'Reassign or escalate immediately.');
  });
}

function detectNoActivity({ tasks, cfg }) {
  const out = [];
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const since = daysAgo(t.last_activity_at);
    if (since === null) continue;
    if (since >= cfg.risk_no_activity_high_days) out.push(finding('no_activity', 'high', t, `No activity for ${since} day(s)`, 'Owner check-in required.'));
    else if (since >= cfg.risk_no_activity_medium_days) out.push(finding('no_activity', 'medium', t, `No activity for ${since} day(s)`, 'Status update needed.'));
  }
  return out;
}

function detectReviewPending({ tasks, cfg }) {
  return tasks.filter(t => t.status === 'ready_for_review').map(t => {
    const age = daysAgo(t.submitted_for_review_at || t.last_status_change) || 0;
    const level = age >= cfg.risk_review_high_days ? 'high' : age >= 3 ? 'medium' : 'low';
    return finding('review_pending', level, t, `Awaiting review for ${age} day(s)`, 'Admin to review or reassign reviewer.');
  });
}

function detectMissingDocs({ docs, cfg, tasksByClient }) {
  return docs.map(d => {
    const age = daysAgo(d.requested_date) || 0;
    const level = age >= cfg.risk_docs_pending_high ? 'high' : age >= cfg.risk_docs_pending_medium ? 'medium' : 'low';
    return {
      kind: 'missing_document',
      level,
      entity: { kind: 'document', id: d.id, name: d.document_name },
      clientId: d.client_external_id,
      clientName: d.client_name,
      evidence: `${age} day(s) pending` + (d.reminder_count ? ` · ${d.reminder_count} reminder(s)` : ''),
      recommendation: age >= cfg.risk_docs_pending_high ? 'Escalate document request to client manager.' : 'Send reminder.'
    };
  });
}

function detectDeadlineApproaching({ tasks, cfg }) {
  const out = [];
  for (const t of tasks) {
    if (!isOpen(t) || !t.due_date) continue;
    const d = daysUntil(t.due_date);
    if (d < 0) continue; // overdue handled separately
    const notStarted = ['not_started','waiting_documents','blocked'].includes(t.status);
    if (d <= cfg.risk_deadline_critical_days && notStarted)
      out.push(finding('deadline_approaching', 'critical', t, `Due in ${d} day(s); status is ${t.status}`, 'Start immediately or escalate.'));
    else if (d <= cfg.risk_deadline_high_days && notStarted)
      out.push(finding('deadline_approaching', 'high', t, `Due in ${d} day(s); status is ${t.status}`, 'Move into progress.'));
    else if (d <= 14 && t.status === 'not_started')
      out.push(finding('deadline_approaching', 'medium', t, `Due in ${d} day(s); not started`, 'Schedule work.'));
  }
  return out;
}

function detectVatRegistrationPending({ tasks, cfg }) {
  return tasks
    .filter(t => t.task_type === 'VAT_Registration' && isOpen(t))
    .map(t => {
      const age = daysAgo(t.created_date) || 0;
      const level = age >= cfg.risk_registration_high_days ? 'high' : 'medium';
      return finding('vat_registration_pending', level, t, `Pending for ${age} day(s)`, 'Prioritize VAT registration.');
    });
}
function detectCtRegistrationPending({ tasks, cfg }) {
  return tasks
    .filter(t => t.task_type === 'CT_Registration' && isOpen(t))
    .map(t => {
      const age = daysAgo(t.created_date) || 0;
      const level = age >= cfg.risk_registration_high_days ? 'high' : 'medium';
      return finding('ct_registration_pending', level, t, `Pending for ${age} day(s)`, 'CT registration is mandatory — prioritize.');
    });
}

function detectAccountingNotCompleted({ tasks }) {
  return tasks
    .filter(t => t.task_type === 'Accounting_Bookkeeping' && isOpen(t))
    .map(t => {
      const age = daysAgo(t.created_date) || 0;
      const level = age > 14 ? 'high' : age > 7 ? 'medium' : 'low';
      return finding('accounting_pending', level, t, `Bookkeeping open for ${age} day(s)`, 'Complete before filing workflows begin.');
    });
}

// Onboarding stalled — proxy: client has no compliance activity in 30+ days
// AND has no completed onboarding tasks. Without Phase 4 onboarding tracking
// this is a best-effort signal.
function detectOnboardingStalled({ clients, tasksByClient }) {
  const out = [];
  for (const c of clients) {
    const list = tasksByClient[String(c.id)] || [];
    if (list.length === 0) {
      const created = c.createdAt || c.created_at;
      const age = daysAgo(created);
      if (age !== null && age > 14) {
        out.push({
          kind: 'onboarding_stalled', level: 'medium',
          entity: { kind: 'client', id: c.id, name: c.name }, clientId: c.id, clientName: c.name,
          evidence: `Client created ${age} day(s) ago with no compliance tasks`,
          recommendation: 'Initiate onboarding.'
        });
      }
    }
  }
  return out;
}

// Client Confirmation pending — needs Phase 4 readiness.
function detectClientConfirmationPending({ readinessByWorkflow }) {
  const out = [];
  for (const r of readinessByWorkflow) {
    if (r.state === 'partially_ready' && r.reason === 'client_confirmation_pending') {
      out.push({
        kind: 'client_confirmation_pending', level: 'high',
        entity: { kind: 'workflow', id: r.workflowId, name: `${r.workflowType} ${r.periodLabel || ''}`.trim() },
        clientId: r.clientId, clientName: r.clientName, taskId: r.taskId,
        evidence: `Awaiting client confirmation on ${r.workflowType} ${r.periodLabel || ''}`,
        recommendation: 'Follow up with client for confirmation.'
      });
    }
  }
  return out;
}

// ---------- Registry & helpers ----------
const DETECTORS = [
  { key: 'overdue',                     fn: detectOverdue },
  { key: 'no_activity',                 fn: detectNoActivity },
  { key: 'review_pending',              fn: detectReviewPending },
  { key: 'missing_document',            fn: detectMissingDocs },
  { key: 'deadline_approaching',        fn: detectDeadlineApproaching },
  { key: 'vat_registration_pending',    fn: detectVatRegistrationPending },
  { key: 'ct_registration_pending',     fn: detectCtRegistrationPending },
  { key: 'accounting_pending',          fn: detectAccountingNotCompleted },
  { key: 'onboarding_stalled',          fn: detectOnboardingStalled },
  { key: 'client_confirmation_pending', fn: detectClientConfirmationPending }
];

function finding(kind, level, t, evidence, recommendation) {
  return {
    kind, level,
    entity: { kind: 'task', id: t.id, name: t.task_type + (t.title ? ' — ' + t.title : '') },
    taskId: t.id,
    clientId: t.client_external_id,
    clientName: t.client_name,
    userId: t.assigned_user_id,
    userName: t.assigned_user_name,
    type: t.task_type,
    evidence,
    recommendation
  };
}

// ---------- Run all ----------
async function runAll() {
  const [tasks, docs, cfg, readinessByWorkflow] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.WorkloadConfigRepo.getAll(),
    readinessService.assessAllFilings().catch(() => [])
  ]);
  const clients = repos.ClientsRepo.listAll();
  const tasksByClient = {};
  tasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });

  const ctx = { tasks, docs, cfg, clients, tasksByClient, readinessByWorkflow };
  const findings = [];
  for (const d of DETECTORS) {
    try {
      const result = d.fn(ctx);
      if (Array.isArray(result)) findings.push(...result);
    } catch (e) {
      console.error('[risk] detector', d.key, e.message);
    }
  }

  // Dedupe at (taskId|docId, kind).
  const seen = new Set();
  const deduped = findings.filter(f => {
    const k = f.kind + ':' + (f.taskId || (f.entity && f.entity.id) || f.clientId);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { findings: deduped, config: cfg, totals: tally(deduped) };
}

function tally(findings) {
  const t = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach(f => { t[f.level]++; });
  return t;
}

// ---------- Grouping helpers ----------
function groupBy(findings, key) {
  const out = {};
  findings.forEach(f => {
    const k = (key === 'client') ? (f.clientName || f.clientId || 'Unknown')
            : (key === 'user')   ? (f.userName   || 'Unassigned')
            :                      (f.kind);
    out[k] = out[k] || { key: k, totals: { critical:0, high:0, medium:0, low:0 }, items: [] };
    out[k].totals[f.level]++;
    out[k].items.push(f);
  });
  return Object.values(out).sort((a,b) =>
    (b.totals.critical*100 + b.totals.high*10 + b.totals.medium) -
    (a.totals.critical*100 + a.totals.high*10 + a.totals.medium)
  );
}

// ---------- Client escalation score ----------
function computeClientScores(findings, cfg, clients) {
  const w = {
    critical: cfg.client_score_critical_weight || 25,
    high:     cfg.client_score_high_weight     || 10,
    medium:   cfg.client_score_medium_weight   || 3,
    low:      cfg.client_score_low_weight      || 1
  };
  const amberAt = cfg.client_score_band_amber || 16;
  const redAt   = cfg.client_score_band_red   || 40;

  const byClient = {};
  findings.forEach(f => {
    const k = f.clientId == null ? null : String(f.clientId);
    if (!k) return;
    byClient[k] = byClient[k] || { clientId: k, clientName: f.clientName, score: 0, totals: { critical:0, high:0, medium:0, low:0 } };
    byClient[k].score += w[f.level] || 0;
    byClient[k].totals[f.level]++;
  });

  // Cap at 100 and assign band.
  const rows = Object.values(byClient).map(r => {
    r.score = Math.min(100, r.score);
    r.band = r.score >= redAt ? 'red' : r.score >= amberAt ? 'amber' : 'green';
    return r;
  });

  // Make sure all clients show up.
  (clients || []).forEach(c => {
    const k = String(c.id);
    if (!byClient[k]) rows.push({ clientId: k, clientName: c.name, score: 0, totals: { critical:0, high:0, medium:0, low:0 }, band: 'green' });
  });

  return rows.sort((a,b) => b.score - a.score);
}

module.exports = { runAll, groupBy, computeClientScores };
