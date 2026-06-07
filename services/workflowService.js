// Workflow service — start a workflow instance, advance steps (gated),
// expose current state. Templates live in templates.js so DB stays lean.
const repos = require('../repositories');
const { getTemplate, TEMPLATES } = require('../templates');

function buildSourceKey(clientId, workflowType, periodLabel) {
  return `wf:${clientId}:${workflowType}:${periodLabel || 'once'}`;
}

// Idempotent: if a workflow already exists for the source_key, return it.
async function startWorkflow({ clientId, clientName, workflowType, periodLabel, obligationId, taskId }) {
  const tmpl = getTemplate(workflowType);
  if (!tmpl) throw new Error('Unknown workflow type: ' + workflowType);
  const sourceKey = buildSourceKey(clientId, workflowType, periodLabel);

  const existing = await repos.WorkflowsRepo.getBySourceKey(sourceKey);
  if (existing) return getWorkflow(existing.id);

  const wf = await repos.WorkflowsRepo.create({
    client_external_id: String(clientId),
    client_name: clientName,
    workflow_type: workflowType,
    period_label: periodLabel || null,
    obligation_id: obligationId || null,
    task_id: taskId || null,
    current_step_key: tmpl.steps[0].key,
    source_key: sourceKey
  });

  const rows = tmpl.steps.map((s, i) => ({
    workflow_id: wf.id,
    step_order: i,
    step_key: s.key,
    step_label: s.label,
    status: i === 0 ? 'in_progress' : 'locked'
  }));
  await repos.WorkflowStepsRepo.bulkInsert(rows);

  return getWorkflow(wf.id);
}

async function getWorkflow(id) {
  const wf = await repos.WorkflowsRepo.getById(id);
  if (!wf) return null;
  const steps = await repos.WorkflowStepsRepo.listForWorkflow(id);
  return { workflow: wf, steps };
}

async function listForClient(clientId, filter = {}) {
  return repos.WorkflowsRepo.list(Object.assign({ clientId }, filter));
}

async function listAll(filter = {}) {
  return repos.WorkflowsRepo.list(filter);
}

// Advance the currently in_progress step. The next step becomes in_progress.
// If `requireKey` is provided, the in_progress step's key must match — prevents
// race conditions when multiple users have the workflow open.
async function advanceStep({ workflowId, requireKey, userId, userName, notes, isAdmin, forceStepKey }) {
  const wf = await repos.WorkflowsRepo.getById(workflowId);
  if (!wf) throw new Error('Workflow not found');
  if (wf.status !== 'active') throw new Error('Workflow is ' + wf.status);
  const steps = await repos.WorkflowStepsRepo.listForWorkflow(workflowId);

  let current = steps.find(s => s.status === 'in_progress');

  // Admin override: jump to a specific step. Skipped intermediate steps marked 'skipped'.
  if (forceStepKey) {
    if (!isAdmin) throw new Error('Override requires admin');
    const target = steps.find(s => s.step_key === forceStepKey);
    if (!target) throw new Error('Unknown step: ' + forceStepKey);
    // Mark prior pending/in_progress/locked steps before target as skipped.
    for (const s of steps) {
      if (s.step_order < target.step_order && s.status !== 'completed') {
        await repos.WorkflowStepsRepo.update(s.id, { status: 'skipped', notes: (s.notes ? s.notes + '\n' : '') + '[admin override skip]' });
      }
    }
    await repos.WorkflowStepsRepo.update(target.id, { status: 'in_progress' });
    await repos.WorkflowsRepo.update(workflowId, { current_step_key: target.step_key });
    repos.ActivityRepo.log(userId, userName, 'workflow_override', `wf=${workflowId} → ${target.step_key}`);
    return getWorkflow(workflowId);
  }

  if (!current) throw new Error('No in-progress step (workflow completed?)');
  if (requireKey && current.step_key !== requireKey) {
    throw new Error('Concurrency: current step is ' + current.step_key + ', not ' + requireKey);
  }

  // Complete the current step.
  await repos.WorkflowStepsRepo.update(current.id, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_by_id: userId || null,
    completed_by_name: userName || null,
    notes: notes || current.notes || null
  });

  // Unlock the next one, if any.
  const next = steps.find(s => s.step_order === current.step_order + 1);
  if (next) {
    await repos.WorkflowStepsRepo.update(next.id, { status: 'in_progress' });
    await repos.WorkflowsRepo.update(workflowId, { current_step_key: next.step_key });
  } else {
    // No next step → workflow complete.
    await repos.WorkflowsRepo.update(workflowId, { status: 'completed', current_step_key: null });
  }

  repos.ActivityRepo.log(userId, userName, 'workflow_step_done', `wf=${workflowId} step=${current.step_key}`);
  return getWorkflow(workflowId);
}

module.exports = {
  startWorkflow,
  getWorkflow,
  listForClient,
  listAll,
  advanceStep,
  buildSourceKey,
  TEMPLATES
};
