// Client Lifecycle Service — composes a single payload that summarizes a
// client's compliance posture across every lifecycle stage. Used by the
// client detail page so the user sees the full picture immediately.
//
// Stages reported:
//   Onboarding, VAT Registration, CT Registration, Accounting, Review,
//   Client Approval, Filing, Overall Readiness
//
// Pure aggregation over existing repositories/services — no new storage.

const repos = require('../repositories');
const readinessService = require('./readinessService');
const riskService = require('./riskService');
const healthScore = require('../healthScore');
const { getTemplate } = require('../templates');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

function pickLatest(workflows) {
  if (!workflows || !workflows.length) return null;
  // Prefer active over completed; within each, latest updated.
  const active = workflows.filter(w => w.status === 'active');
  const pool = active.length ? active : workflows;
  return pool.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
}

async function workflowStepStatus(workflowId, stepKey) {
  if (!workflowId) return null;
  const steps = await repos.WorkflowStepsRepo.listForWorkflow(workflowId);
  const step = steps.find(s => s.step_key === stepKey);
  return step ? { status: step.status, completedAt: step.completed_at, completedBy: step.completed_by_name } : null;
}

// ---------- Status resolvers ----------

// Onboarding: we don't have a dedicated checklist yet (full Phase 4). Best
// signal from existing data: if the client has at least one completed
// compliance task or active workflow, treat onboarding as complete. If they
// have NO compliance tasks and were created > 14 days ago, mark as stalled.
function resolveOnboarding(client, tasksForClient) {
  if (!tasksForClient || tasksForClient.length === 0) {
    const age = daysAgo(client.createdAt || client.created_at);
    if (age !== null && age > 14) return { status: 'pending', detail: `Stalled — created ${age} day(s) ago, no compliance activity yet.` };
    return { status: 'in_progress', detail: 'Awaiting first compliance task.' };
  }
  return { status: 'complete', detail: 'Onboarding complete — client has active compliance activity.' };
}

function resolveRegistration(tasksForClient, kind) {
  // kind = 'VAT_Registration' | 'CT_Registration'
  const list = tasksForClient.filter(t => t.task_type === kind);
  if (!list.length) {
    if (kind === 'VAT_Registration') return { status: 'not_required', detail: 'No VAT registration task — assumed not required.' };
    return { status: 'pending', detail: 'No registration record yet — CT registration is mandatory.' };
  }
  const completed = list.find(t => t.status === 'completed');
  if (completed) return { status: 'completed', detail: `Completed on ${completed.completed_date ? completed.completed_date.slice(0,10) : '—'}.` };
  const inProgress = list.find(t => t.status === 'in_progress');
  if (inProgress) return { status: 'in_progress', detail: 'Registration task in progress.' };
  const open = list[0];
  const age = daysAgo(open.created_date) || 0;
  return { status: 'pending', detail: `Registration pending for ${age} day(s).` };
}

// Accounting / Review / Client Approval / Filing — read from VAT/CT_Filing
// workflows. We aggregate across all active filing workflows for the client.
function aggregateStepAcross(workflows, stepKey, stepsByWorkflow) {
  // Returns the WORST stage among all active workflows so the user sees the
  // current bottleneck rather than the best-case.
  if (!workflows.length) return { status: 'none', detail: 'No active filing workflow.' };
  let completedCount = 0, inProgressCount = 0, lockedCount = 0;
  const evidence = [];
  for (const wf of workflows) {
    const steps = stepsByWorkflow[wf.id] || [];
    const s = steps.find(x => x.step_key === stepKey);
    if (!s) continue;
    if (s.status === 'completed') completedCount++;
    else if (s.status === 'in_progress') { inProgressCount++; evidence.push(`${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label || ''} — in progress`); }
    else { lockedCount++; evidence.push(`${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label || ''} — locked`); }
  }
  if (lockedCount > 0)     return { status: 'pending',     detail: evidence.join('; ') };
  if (inProgressCount > 0) return { status: 'in_progress', detail: evidence.join('; ') };
  if (completedCount > 0)  return { status: 'completed',   detail: `Completed across ${completedCount} workflow(s).` };
  return { status: 'none', detail: 'Step not applicable.' };
}

// ---------- Main composer ----------
async function getLifecycleSummary(clientId) {
  const client = repos.ClientsRepo.findById(clientId);
  if (!client) return null;

  const [allTasks, workflows] = await Promise.all([
    repos.TasksRepo.listByClient(clientId, { limit: 1000 }),
    repos.WorkflowsRepo.list({ clientId: clientId, limit: 200 })
  ]);

  // Steps per workflow (single batched query)
  const filingWorkflows = workflows.filter(w => (w.workflow_type === 'VAT_Filing' || w.workflow_type === 'CT_Filing') && w.status === 'active');
  const stepsByWorkflow = await repos.WorkflowStepsRepo.listForWorkflows(filingWorkflows.map(w => w.id));

  const onboarding   = resolveOnboarding(client, allTasks);
  const vatReg       = resolveRegistration(allTasks, 'VAT_Registration');
  const ctReg        = resolveRegistration(allTasks, 'CT_Registration');
  const accounting   = aggregateStepAcross(filingWorkflows, 'Accounting_Completed',          stepsByWorkflow);
  const review       = aggregateStepAcross(filingWorkflows, 'Internal_Review_Completed',     stepsByWorkflow);
  const approval     = aggregateStepAcross(filingWorkflows, 'Client_Confirmation_Obtained',  stepsByWorkflow);
  // Filing step key differs by workflow type — aggregate manually.
  const filingState = (function() {
    if (!filingWorkflows.length) return { status: 'none', detail: 'No active filing workflow.' };
    let inProgress = 0, completed = 0, locked = 0;
    const ev = [];
    for (const wf of filingWorkflows) {
      const tmpl = getTemplate(wf.workflow_type);
      const key = tmpl && tmpl.filingStepKey;
      if (!key) continue;
      const s = (stepsByWorkflow[wf.id] || []).find(x => x.step_key === key);
      if (!s) continue;
      if (s.status === 'completed') completed++;
      else if (s.status === 'in_progress') { inProgress++; ev.push(`${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label || ''}`); }
      else { locked++; ev.push(`${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label || ''} — locked`); }
    }
    if (inProgress > 0) return { status: 'in_progress', detail: 'Filing in progress: ' + ev.join('; ') };
    if (completed > 0 && locked === 0) return { status: 'completed', detail: `Filed for ${completed} period(s).` };
    if (locked > 0) return { status: 'pending', detail: ev.join('; ') };
    return { status: 'pending', detail: 'No filing step active.' };
  })();

  // Overall readiness — uses readinessService classification across all
  // active filing workflows; reports the *worst* state (so a single not-ready
  // workflow surfaces as the overall posture).
  const readinessRows = await Promise.all(filingWorkflows.map(wf =>
    readinessService.assessWorkflow(wf.id).catch(() => null)
  ));
  const order = { not_ready: 0, partially_ready: 1, ready_for_filing: 2, completed: 3 };
  let overallReadiness = 'completed';
  let worstReadiness = null;
  for (const r of readinessRows.filter(Boolean)) {
    if (worstReadiness == null || (order[r.state] != null && order[r.state] < order[worstReadiness])) {
      worstReadiness = r.state; overallReadiness = r.state;
    }
  }
  if (!filingWorkflows.length) overallReadiness = 'none';

  // Health + escalation
  const [health, riskData] = await Promise.all([
    healthScore.computeForClient(client).catch(() => null),
    riskService.runAll()
  ]);
  const clientScores = riskService.computeClientScores(riskData.findings, riskData.config, [client]);
  const escalation = clientScores.find(s => String(s.clientId) === String(clientId)) || { score: 0, band: 'green', totals: { critical:0, high:0, medium:0, low:0 } };
  const clientFindings = riskData.findings.filter(f => String(f.clientId) === String(clientId));

  // Blockers + next actions
  const blockers = [];
  if (onboarding.status === 'pending')   blockers.push('Onboarding stalled: ' + onboarding.detail);
  if (vatReg.status === 'pending')       blockers.push('VAT registration pending.');
  if (ctReg.status === 'pending')        blockers.push('CT registration pending — mandatory.');
  if (accounting.status === 'pending')   blockers.push('Accounting not yet completed.');
  if (review.status === 'pending')       blockers.push('Internal review not yet completed.');
  if (approval.status === 'in_progress' || approval.status === 'pending') blockers.push('Awaiting client confirmation.');

  const nextActions = [];
  for (const wf of filingWorkflows) {
    const steps = stepsByWorkflow[wf.id] || [];
    const current = steps.find(s => s.status === 'in_progress');
    if (current) {
      nextActions.push({
        title: `${wf.workflow_type.replace(/_/g,' ')} ${wf.period_label || ''} → ${current.step_label}`,
        workflowId: wf.id, stepKey: current.step_key
      });
    }
  }

  return {
    client: { id: client.id, name: client.name, owner: client.assignedTeam || null, createdAt: client.createdAt || client.created_at || null },
    stages: { onboarding, vatRegistration: vatReg, ctRegistration: ctReg, accounting, review, clientApproval: approval, filing: filingState },
    overallReadiness,
    health, escalation,
    findings: clientFindings,
    blockers, nextActions,
    workflows: workflows.map(w => ({ id: w.id, workflow_type: w.workflow_type, period_label: w.period_label, status: w.status, current_step_key: w.current_step_key }))
  };
}

module.exports = { getLifecycleSummary };
