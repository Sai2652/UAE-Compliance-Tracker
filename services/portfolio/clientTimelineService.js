// Unified history timeline for one client. Reads events from existing tables
// and emits a single chronologically sorted stream.
const repos = require('../../repositories');

async function getTimeline(clientId, limit) {
  const cap = limit || 200;
  const cid = String(clientId);

  // Tasks (created + completed events)
  const tasks = await repos.TasksRepo.listByClient(cid, { limit: 1000 });
  const events = [];

  tasks.forEach(t => {
    if (t.created_date) events.push({ at: t.created_date, kind: 'task_created', taskType: t.task_type, taskId: t.id, label: t.task_type.replace(/_/g,' ') + ' created' + (t.title ? ' — ' + t.title : '') });
    if (t.completed_date) events.push({ at: t.completed_date, kind: 'task_completed', taskType: t.task_type, taskId: t.id, label: t.task_type.replace(/_/g,' ') + ' completed' });
    if (t.submitted_for_review_at) events.push({ at: t.submitted_for_review_at, kind: 'task_submitted_review', taskType: t.task_type, taskId: t.id, label: 'Submitted for review: ' + t.task_type.replace(/_/g,' ') });
    if (t.last_escalated_at) events.push({ at: t.last_escalated_at, kind: 'task_escalated', taskType: t.task_type, taskId: t.id, label: 'Task escalated: ' + t.task_type.replace(/_/g,' ') });
  });

  // Document requests
  const docs = await repos.DocumentsRepo.listForClient(cid);
  docs.forEach(d => {
    if (d.requested_date) events.push({ at: d.requested_date, kind: 'doc_requested', label: 'Document requested: ' + d.document_name });
    if (d.received_date)  events.push({ at: d.received_date,  kind: 'doc_received',  label: 'Document received: ' + d.document_name });
  });

  // Obligations (filings due/filed)
  const obls = await repos.ObligationsRepo.list({ clientId: cid, limit: 1000 });
  obls.forEach(o => {
    if (o.filed_at) events.push({ at: o.filed_at, kind: 'obligation_filed', label: `${o.obligation_type.replace(/_/g,' ')} ${o.period_label} filed` });
    if (o.filing_deadline) events.push({ at: new Date(o.filing_deadline + 'T00:00:00Z').toISOString(), kind: 'obligation_due', label: `${o.obligation_type.replace(/_/g,' ')} ${o.period_label} deadline` });
  });

  // Escalation events + Review events (per-task lookup via GSI, batched)
  const taskIds = tasks.map(t => t.id);
  if (taskIds.length) {
    const [escs, revs] = await Promise.all([
      repos.EscalationEventsRepo.listForTasks(taskIds),
      repos.ReviewEventsRepo.listForTasks(taskIds)
    ]);
    escs.forEach(e => events.push({ at: e.triggered_at, kind: 'escalation_triggered', label: 'Escalation: ' + (e.rule_name || ''), severity: e.severity, taskId: e.task_id }));
    revs.forEach(r => events.push({ at: r.reviewed_at, kind: 'review_'+r.decision, label: 'Review ' + r.decision + ' by ' + (r.reviewer_user_name || ''), taskId: r.task_id }));
  }

  // Workflows — confirmation steps (client confirmations history) — batched fetch
  const wfs = await repos.WorkflowsRepo.list({ clientId: cid, limit: 200 });
  const stepsByWf = await repos.WorkflowStepsRepo.listForWorkflows(wfs.map(w => w.id));
  wfs.forEach(wf => {
    const steps = stepsByWf[wf.id] || [];
    steps.filter(s => s.completed_at).forEach(s => {
      events.push({ at: s.completed_at, kind: 'workflow_step', label: `${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label||''} — ${s.step_label} done`, workflowId: wf.id });
    });
  });

  events.sort((a,b) => (b.at || '').localeCompare(a.at || ''));
  return { clientId: cid, total: events.length, events: events.slice(0, cap) };
}

module.exports = { getTimeline };
