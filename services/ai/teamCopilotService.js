// Team Copilot — "My Next Best Tasks" for a single user. Adds workflow
// dependency awareness on top of the already tier-weighted priority_score.
//
// Bonus model (configurable later):
//   +15 if this task is the active workflow step's task type for the client
//   +10 if the predecessor workflow step is completed
//   +5  if completing this task unblocks the next workflow step
//
// Output is a ranked list of up to 10 tasks, each with a `rationale` field.

const repos = require('../../repositories');
const clientSettings = require('../portfolio/clientSettingsService');
const clientReadinessService = require('../clientReadinessService');
const explain = require('./explanationEngine');
const { getTemplate } = require('../../templates');

const PREDECESSOR_BONUS = 10;
const UNBLOCKS_BONUS = 5;
const WORKFLOW_MATCH_BONUS = 15;

// Map task_type → workflow step key (best-effort, for the bonus only).
const TASK_TYPE_TO_STEP = {
  Accounting_Bookkeeping: 'Accounting_Completed',
  VAT_Filing: 'VAT_Return_Filed',
  CT_Filing: 'CT_Return_Filed',
  Review: 'Internal_Review_Completed'
};

async function getMyNextBest(userId) {
  const [tasks, settingsMap, readinessData] = await Promise.all([
    repos.TasksRepo.listByAssignee(userId, { notStatus: ['completed'], limit: 500 }),
    clientSettings.getAllAsMap(),
    clientReadinessService.getAllClientReadiness().catch(() => ({ clients: [] }))
  ]);
  const readinessByClient = {}; (readinessData.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });

  // Pre-load workflow steps for every workflow referenced.
  const wfIds = Array.from(new Set(tasks.map(t => t.obligation_id).filter(Boolean)));
  const workflows = wfIds.length
    ? await repos.WorkflowsRepo.list({ limit: 1000 })
    : [];
  const wfByObligation = {}; workflows.forEach(w => { if (w.obligation_id) wfByObligation[w.obligation_id] = w; });

  const stepsByWorkflow = await repos.WorkflowStepsRepo.listForWorkflows(workflows.map(w => w.id));

  const decorated = tasks.map(t => {
    const ctx = decorateTaskContext(t, settingsMap, readinessByClient, wfByObligation, stepsByWorkflow);
    const bonus = computeBonus(ctx);
    const finalScore = (t.priority_score || 0) + bonus;
    return {
      taskId: t.id,
      clientId: t.client_external_id, clientName: t.client_name,
      taskType: t.task_type, status: t.status,
      dueDate: t.due_date,
      tier: ctx.tier, readinessState: ctx.readinessState,
      priorityScore: t.priority_score || 0,
      adjustedScore: finalScore,
      bonusApplied: bonus,
      rationale: explain.explainTask(t, ctx)
    };
  }).sort((a, b) => b.adjustedScore - a.adjustedScore).slice(0, 10);

  return { userId, tasks: decorated };
}

function decorateTaskContext(task, settingsMap, readinessByClient, wfByObligation, stepsByWorkflow) {
  const tier = (settingsMap[String(task.client_external_id)] || {}).tier || 'B';
  const readiness = readinessByClient[String(task.client_external_id)];
  const ctx = { tier, readinessState: readiness ? readiness.state : null, predecessorComplete: false, unblocksNext: false, currentStepMatch: false };

  const wf = task.obligation_id ? wfByObligation[task.obligation_id] : null;
  if (!wf) return ctx;
  const steps = stepsByWorkflow[wf.id] || [];
  const tmpl = getTemplate(wf.workflow_type);
  if (!tmpl) return ctx;

  // Find the in-progress step.
  const inProgressStep = steps.find(s => s.status === 'in_progress');
  if (!inProgressStep) return ctx;

  // Does this task's type match the current step?
  const expectedStepKey = TASK_TYPE_TO_STEP[task.task_type];
  if (expectedStepKey && inProgressStep.step_key === expectedStepKey) {
    ctx.currentStepMatch = true;
  }
  // Predecessor complete?
  const idx = steps.findIndex(s => s.id === inProgressStep.id);
  if (idx > 0 && steps[idx - 1].status === 'completed') ctx.predecessorComplete = true;
  // Will completing unblock a next step?
  if (idx < steps.length - 1) ctx.unblocksNext = true;
  return ctx;
}

function computeBonus(ctx) {
  let b = 0;
  if (ctx.currentStepMatch) b += WORKFLOW_MATCH_BONUS;
  if (ctx.predecessorComplete) b += PREDECESSOR_BONUS;
  if (ctx.unblocksNext) b += UNBLOCKS_BONUS;
  return b;
}

module.exports = { getMyNextBest };
