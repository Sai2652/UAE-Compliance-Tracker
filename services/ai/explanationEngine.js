// Explanation Engine — converts structured findings/rows into short,
// imperative, traceable sentences. Pure functions, no I/O.
//
// EVERY sentence is derived from a `reasons` array (or equivalent structured
// data on the input row). We never invent facts: if there is no evidence on
// the row, we return null and the caller decides.
//
// The same templates are used across the Daily Briefing, Manager Copilot,
// Manager Action List rationale, and Client Insight Panel.

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d)   { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }
function safe(s)      { return s == null ? '' : String(s); }
function ttype(t)     { return safe(t).replace(/_/g, ' '); }
function cap(s, n)    { if (!s) return s; return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- Per-finding templates (risk_engine kinds + workflow states) ----------

const TEMPLATES = {
  overdue: (f) => `${f.clientName} — ${ttype(f.type)} is overdue. Reassign or escalate today.`,
  no_activity: (f) => `${f.clientName} — ${ttype(f.type)} has had no activity in ${parseEvidenceDays(f.evidence)} days. Owner check-in needed.`,
  review_pending: (f) => `${f.clientName}'s ${ttype(f.type)} has been awaiting review for ${parseEvidenceDays(f.evidence)} days. Assign a reviewer now.`,
  missing_document: (f) => `${f.clientName} is missing "${cap(extractDocName(f), 40)}" — pending ${parseEvidenceDays(f.evidence)} days. Escalate the request.`,
  deadline_approaching: (f) => {
    const m = /Due in (-?\d+)/.exec(f.evidence || '');
    const n = m ? parseInt(m[1], 10) : null;
    if (n != null && n <= 2) return `${f.clientName} — ${ttype(f.type)} due in ${n} day(s). Status is ${f.evidence.split('status is ').pop() || 'not started'}. Start immediately.`;
    return `${f.clientName} — ${ttype(f.type)} ${f.evidence}. Move into progress.`;
  },
  vat_registration_pending: (f) => `${f.clientName} — VAT registration pending for ${parseEvidenceDays(f.evidence)} days. Prioritise to unblock VAT compliance.`,
  ct_registration_pending: (f) => `${f.clientName} — CT registration pending for ${parseEvidenceDays(f.evidence)} days. CT registration is mandatory.`,
  accounting_pending: (f) => `${f.clientName} — bookkeeping open for ${parseEvidenceDays(f.evidence)} days. Close before filing workflows begin.`,
  onboarding_stalled: (f) => `${f.clientName} — onboarding stalled. Begin the onboarding workflow.`,
  client_confirmation_pending: (f) => `${f.clientName} — awaiting client confirmation on ${ttype(f.entity && f.entity.name)}. Follow up with the client today.`
};

function explainFinding(f) {
  if (!f) return null;
  const t = TEMPLATES[f.kind];
  if (t) return t(f);
  // Generic fallback — always traceable to evidence.
  if (f.evidence && f.clientName) return `${f.clientName}: ${f.evidence}. ${f.recommendation || ''}`.trim();
  return null;
}

function parseEvidenceDays(evidence) {
  const m = /(\d+)\s*day/.exec(evidence || ''); return m ? parseInt(m[1], 10) : '?';
}
function extractDocName(f) {
  return (f.entity && f.entity.name) || 'a document';
}

// ---------- Composite explanations (multi-finding per client) ----------

// Renders a one-line "headline" + a bullet list of reasons for one client.
// Used by the Daily Briefing top-10 and the Client Insight Panel.
function explainClient(clientName, findings, riskBand) {
  const sorted = sortByImpact(findings);
  const top = sorted.slice(0, 3).map(explainFinding).filter(Boolean);
  if (!top.length) return null;
  const headline = headlineForClient(clientName, sorted[0], riskBand);
  return { headline, reasons: top, all: sorted.map(explainFinding).filter(Boolean) };
}
function sortByImpact(findings) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return (findings || []).slice().sort((a, b) => (order[a.level] || 9) - (order[b.level] || 9));
}
function headlineForClient(clientName, top, riskBand) {
  if (!top) return clientName;
  const band = riskBand ? riskBand.toUpperCase() + ' RISK — ' : '';
  return `${band}${clientName} requires attention: ${explainFinding(top)}`;
}

// ---------- Workflow / readiness state explanations ----------

function explainReadiness(row) {
  if (!row) return null;
  switch (row.state) {
    case 'high_risk':                return `${row.clientName} is in the red risk band — open an immediate review.`;
    case 'blocked':                  return `${row.clientName} has blocked work — unblock or escalate today.`;
    case 'filing_due':               return `${row.clientName} has a filing deadline within 7 days that is not yet complete.`;
    case 'awaiting_client_approval': return `${row.clientName} is waiting on client confirmation. Follow up directly.`;
    case 'awaiting_documents':       return `${row.clientName} is waiting on documents. Escalate stale requests.`;
    case 'awaiting_review':          return `${row.clientName} has work waiting for internal review — assign a reviewer.`;
    case 'partially_ready':          return `${row.clientName} is partially ready — close remaining steps to reach Ready.`;
    case 'ready':                    return `${row.clientName} is Ready For Filing — proceed.`;
    default: return null;
  }
}

// ---------- Task-level rationale (Team Copilot, AI Priority) ----------

// Given a task row + context (tier, readiness, workflow), return a short
// imperative rationale for WHY this task is ranked where it is.
function explainTask(task, ctx) {
  const reasons = [];
  const daysToDue = daysUntil(task.due_date);
  if (daysToDue != null) {
    if (daysToDue < 0) reasons.push(`overdue by ${-daysToDue}d`);
    else if (daysToDue <= 3) reasons.push(`due in ${daysToDue}d`);
    else if (daysToDue <= 7) reasons.push(`due within a week`);
  }
  if (task.status === 'ready_for_review') reasons.push('awaiting review');
  if (task.status === 'waiting_documents') reasons.push('waiting on documents');
  if (task.escalation_level && task.escalation_level > 0) reasons.push(`escalation level ${task.escalation_level}`);
  if (ctx && ctx.tier === 'A') reasons.push('Tier A client');
  if (ctx && ctx.readinessState && ctx.readinessState !== 'idle' && ctx.readinessState !== 'ready') {
    reasons.push(`client status: ${ctx.readinessState.replace(/_/g,' ')}`);
  }
  if (ctx && ctx.predecessorComplete) reasons.push('predecessor step completed');
  if (ctx && ctx.unblocksNext) reasons.push('unblocks next workflow step');
  if (!reasons.length) reasons.push(`priority score ${task.priority_score || 0}`);
  return `Top because: ${reasons.join(', ')}.`;
}

// ---------- Recommended Next Action sentence (per situation kind) ----------

function recommendedAction(situation, context) {
  const c = context || {};
  switch (situation) {
    case 'awaiting_client_approval':
      return `Follow up with ${c.clientName} for ${c.workflowType ? ttype(c.workflowType) : 'workflow'} confirmation${c.periodLabel ? ' — ' + c.periodLabel : ''}.`;
    case 'missing_document':
      return `Escalate document request${c.documentName ? ' for "' + c.documentName + '"' : ''} (${c.clientName}, pending ${c.days || '?'}d).`;
    case 'overloaded_user':
      return `Reassign ${c.reassignCount || 'some'} task(s) from ${c.userName} to a user with spare capacity.`;
    case 'filing_due_not_ready':
      return `Prioritise ${c.workflowType ? ttype(c.workflowType) : 'filing'} for ${c.clientName} — deadline in ${c.daysToDue || '?'} day(s).`;
    case 'review_backlog':
      return `Assign reviewer to ${c.clientName} — ${ttype(c.taskType)} has been pending ${c.ageDays || '?'} days.`;
    case 'registration_pending':
      return `Push ${c.kind || 'registration'} for ${c.clientName} — open for ${c.days || '?'} days.`;
    case 'accounting_pending':
      return `Close bookkeeping for ${c.clientName} before downstream filings can advance.`;
    case 'deadline_overdue':
      return `Address overdue work for ${c.clientName} immediately or escalate to admin.`;
    default:
      return c.evidence ? `${c.clientName || 'Client'}: ${c.evidence}.` : null;
  }
}

module.exports = {
  explainFinding, explainClient, explainReadiness, explainTask,
  recommendedAction, sortByImpact
};
