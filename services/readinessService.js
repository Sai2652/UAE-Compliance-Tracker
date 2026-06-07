// Readiness service — classifies VAT_Filing / CT_Filing workflows as
// Not Ready / Partially Ready / Ready For Filing for Phase 5 risk detection.
//
// Mapping (per spec):
//   Ready For Filing  = client confirmation step is completed AND filing not yet done
//   Partially Ready   = currently on the client confirmation step (awaiting client)
//                       OR internal review completed, awaiting confirmation
//   Not Ready         = anything earlier
//   Completed         = filing acknowledgement verified (terminal)
const repos = require('../repositories');
const { getTemplate } = require('../templates');
const wfService = require('./workflowService');

function classify(steps, template) {
  if (!template || !template.filingStepKey) return { state: 'not_applicable' };
  const confirmKey = template.confirmationStepKey;
  const filingKey = template.filingStepKey;
  const ackKey = 'Filing_Acknowledgement_Verified';

  const byKey = {};
  steps.forEach(s => { byKey[s.step_key] = s; });

  const ack = byKey[ackKey];
  if (ack && ack.status === 'completed') return { state: 'completed' };

  const confirm = byKey[confirmKey];
  const filing = byKey[filingKey];

  if (confirm && confirm.status === 'completed' && filing && filing.status !== 'completed') {
    return { state: 'ready_for_filing' };
  }
  if (confirm && confirm.status === 'in_progress') {
    return { state: 'partially_ready', reason: 'client_confirmation_pending' };
  }
  const internal = byKey['Internal_Review_Completed'];
  if (internal && internal.status === 'completed' && (!confirm || confirm.status !== 'completed')) {
    return { state: 'partially_ready', reason: 'awaiting_confirmation' };
  }
  // Otherwise we're earlier in the chain.
  const currentInProgress = steps.find(s => s.status === 'in_progress');
  return { state: 'not_ready', currentStep: currentInProgress ? currentInProgress.step_key : null };
}

async function assessWorkflow(workflowId) {
  const data = await wfService.getWorkflow(workflowId);
  if (!data) return null;
  const tmpl = getTemplate(data.workflow.workflow_type);
  const verdict = classify(data.steps, tmpl);
  return { workflowId, workflowType: data.workflow.workflow_type, clientId: data.workflow.client_external_id, periodLabel: data.workflow.period_label, ...verdict };
}

// Bulk assessment across all active VAT/CT filing workflows.
async function assessAllFilings() {
  const workflows = await repos.WorkflowsRepo.list({ workflowType: ['VAT_Filing','CT_Filing'], status: 'active', limit: 5000 });
  const out = [];
  for (const wf of workflows) {
    const steps = await repos.WorkflowStepsRepo.listForWorkflow(wf.id);
    const tmpl = getTemplate(wf.workflow_type);
    const verdict = classify(steps, tmpl);
    out.push({
      workflowId: wf.id,
      workflowType: wf.workflow_type,
      clientId: wf.client_external_id,
      clientName: wf.client_name,
      periodLabel: wf.period_label,
      taskId: wf.task_id,
      obligationId: wf.obligation_id,
      ...verdict
    });
  }
  return out;
}

module.exports = { classify, assessWorkflow, assessAllFilings };
