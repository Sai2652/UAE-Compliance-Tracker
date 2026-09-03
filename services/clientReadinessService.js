// Client Readiness Service — derives ONE worst-case readiness state per
// client, in a single batched sweep, for use in the Clients list, Dashboard
// counts, and filter chips.
//
// State priority (worst-first — first match wins):
//   1. high_risk              — escalation band red
//   2. blocked                — any blocked/escalated open task
//   3. filing_due             — filing workflow with deadline ≤ 7d (or overdue)
//                               AND not yet filed
//   4. awaiting_client_approval — workflow at Client_Confirmation step in_progress
//   5. awaiting_documents     — any pending doc request OR task waiting_documents
//   6. awaiting_review        — any task ready_for_review
//   7. partially_ready        — readinessService says partially_ready
//   8. ready                  — readinessService says ready_for_filing
//   9. idle                   — no signal (new/quiet client)

const repos = require('../repositories');
// isStuck/isEscalated read escalation_level rather than a status of
// 'escalated', which the sweep no longer sets.
const compliance = require('../compliance');
const riskService = require('./riskService');
const readinessService = require('./readinessService');
const clientSettingsService = require('./portfolio/clientSettingsService');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }

const STATES = [
  'high_risk', 'blocked', 'filing_due',
  'awaiting_client_approval', 'awaiting_documents', 'awaiting_review',
  'partially_ready', 'ready', 'idle'
];

const STATE_LABELS = {
  high_risk: 'High Risk',
  blocked: 'Blocked',
  filing_due: 'Filing Due',
  awaiting_client_approval: 'Awaiting Client Approval',
  awaiting_documents: 'Awaiting Documents',
  awaiting_review: 'Awaiting Review',
  partially_ready: 'Partially Ready',
  ready: 'Ready',
  idle: 'Active'
};

// Short-lived (10s) memo — many composite services call this in one HTTP
// request. Without it the readiness sweep runs 3-5 times per page load.
let _readinessCache = null;
async function getAllClientReadiness() {
  if (_readinessCache && (Date.now() - _readinessCache.at) < 10_000) return _readinessCache.value;
  const value = await _getAllImpl();
  _readinessCache = { at: Date.now(), value };
  return value;
}
async function _getAllImpl() {
  // Single batched fetch — avoids N+1 across the fleet.
  const clients = repos.ClientsRepo.listAll();
  const [allTasks, pendingDocs, workflows, riskData, settingsMap] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.WorkflowsRepo.list({ workflowType: ['VAT_Filing', 'CT_Filing'], status: 'active', limit: 5000 }),
    riskService.runAll(),
    clientSettingsService.getAllAsMap().catch(() => ({}))
  ]);

  // Bucket data by client
  const tasksByClient = {};
  allTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });
  const docsByClient = {};
  pendingDocs.forEach(d => { (docsByClient[d.client_external_id] = docsByClient[d.client_external_id] || []).push(d); });
  const wfByClient = {};
  workflows.forEach(w => { (wfByClient[w.client_external_id] = wfByClient[w.client_external_id] || []).push(w); });

  // Steps per workflow — single batched SQL query.
  const stepsByWorkflow = await repos.WorkflowStepsRepo.listForWorkflows(workflows.map(w => w.id));

  const clientScores = riskService.computeClientScores(riskData.findings, riskData.config, clients);
  const escByClient = {};
  clientScores.forEach(r => { escByClient[String(r.clientId)] = r; });

  const rows = clients.map(c => {
    const tasks = tasksByClient[String(c.id)] || [];
    const docs = docsByClient[String(c.id)] || [];
    const wfs = wfByClient[String(c.id)] || [];
    const esc = escByClient[String(c.id)] || { score: 0, band: 'green' };

    const state = deriveState({ client: c, tasks, docs, workflows: wfs, stepsByWorkflow, escalation: esc });
    const settings = settingsMap[String(c.id)] || { tier: 'B' };
    return {
      clientId: c.id, clientName: c.name,
      owner: c.assignedTeam || null,
      tier: settings.tier || 'B',
      partnerOwner: settings.partnerOwner || null,
      state, stateLabel: STATE_LABELS[state],
      escalationBand: esc.band, escalationScore: esc.score,
      openTaskCount: tasks.filter(t => t.status !== 'completed').length,
      pendingDocCount: docs.length,
      activeWorkflowCount: wfs.length
    };
  });

  // Counts per state + per tier
  const counts = {};
  STATES.forEach(s => { counts[s] = 0; });
  rows.forEach(r => { counts[r.state] = (counts[r.state] || 0) + 1; });
  const tierCounts = { A: 0, B: 0, C: 0 };
  rows.forEach(r => { tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1; });

  return { clients: rows, counts, tierCounts, labels: STATE_LABELS };
}

function deriveState(ctx) {
  const { tasks, docs, workflows, stepsByWorkflow, escalation } = ctx;
  const openTasks = tasks.filter(t => t.status !== 'completed');

  // 1. High risk → escalation band red
  if (escalation.band === 'red') return 'high_risk';

  // 2. Blocked
  if (openTasks.some(t => compliance.isStuck(t))) return 'blocked';

  // 3. Filing due (workflow with deadline within 7d and not at final step)
  for (const wf of workflows) {
    // Find the linked task for due_date proxy
    const linkedTask = openTasks.find(t => t.id === wf.task_id) ||
                       openTasks.find(t => t.client_external_id === wf.client_external_id && (t.task_type === 'VAT_Filing' || t.task_type === 'CT_Filing'));
    const dueDate = linkedTask ? linkedTask.due_date : null;
    const d = daysUntil(dueDate);
    if (d !== null && d <= 7) {
      // Only call it filing_due if the actual filing step hasn't completed.
      const steps = stepsByWorkflow[wf.id] || [];
      const filed = steps.find(s => /Return_Filed$/.test(s.step_key));
      if (!filed || filed.status !== 'completed') return 'filing_due';
    }
  }

  // 4. Awaiting client approval — any workflow where Client_Confirmation step is in_progress
  for (const wf of workflows) {
    const steps = stepsByWorkflow[wf.id] || [];
    const confirm = steps.find(s => s.step_key === 'Client_Confirmation_Obtained');
    if (confirm && confirm.status === 'in_progress') return 'awaiting_client_approval';
  }

  // 5. Awaiting documents
  if (docs.length > 0) return 'awaiting_documents';
  if (openTasks.some(t => t.status === 'waiting_documents')) return 'awaiting_documents';

  // 6. Awaiting review
  if (openTasks.some(t => t.status === 'ready_for_review')) return 'awaiting_review';

  // 7/8. Partially / Ready (from readiness classification)
  let bestReadiness = null;
  for (const wf of workflows) {
    const steps = stepsByWorkflow[wf.id] || [];
    const { getTemplate } = require('../templates');
    const tmpl = getTemplate(wf.workflow_type);
    const v = readinessService.classify(steps, tmpl);
    if (v.state === 'ready_for_filing' || v.state === 'partially_ready') {
      // Worst across active workflows: prefer partially_ready over ready
      if (v.state === 'partially_ready') return 'partially_ready';
      bestReadiness = bestReadiness || v.state;
    }
  }
  if (bestReadiness === 'ready_for_filing') return 'ready';

  return 'idle';
}

module.exports = { getAllClientReadiness, STATES, STATE_LABELS };
