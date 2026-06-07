// Responsiveness Score (0-100, higher = more responsive client).
// Pure function over batched data. Designed to be called for all clients in
// one sweep via computeForAll().
const repos = require('../../repositories');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

function computeOne({ clientId, tasks, docs, allDocsForClient, confirmStepsInProgress }, w, coldStartMin) {
  let score = w.resp_base;
  const factors = [];
  let evidenceCount = 0;

  // Stale pending docs (>7d)
  const staleDocs = (docs || []).filter(d => (daysAgo(d.requested_date) || 0) > 7);
  if (staleDocs.length) {
    const loss = Math.min(w.resp_stale_doc_cap, staleDocs.length * w.resp_per_stale_doc);
    score -= loss; evidenceCount += staleDocs.length;
    factors.push({ key:'stale_documents', count: staleDocs.length, impact: -loss });
  }
  // Tasks waiting_documents > 14d
  const waiting14 = (tasks || []).filter(t => t.status === 'waiting_documents' && (daysAgo(t.last_status_change) || 0) > 14);
  if (waiting14.length) {
    const loss = Math.min(w.resp_waiting_docs_cap, waiting14.length * w.resp_per_waiting_docs_14d);
    score -= loss; evidenceCount += waiting14.length;
    factors.push({ key:'waiting_documents_over_14d', count: waiting14.length, impact: -loss });
  }
  // Missed confirmations
  if (confirmStepsInProgress && confirmStepsInProgress.length) {
    const loss = Math.min(w.resp_missed_confirm_cap, confirmStepsInProgress.length * w.resp_per_missed_confirm);
    score -= loss; evidenceCount += confirmStepsInProgress.length;
    factors.push({ key:'missed_confirmations', count: confirmStepsInProgress.length, impact: -loss });
  }
  // Reminders accumulated on pending docs
  const totalReminders = (docs || []).reduce((s, d) => s + (d.reminder_count || 0), 0);
  if (totalReminders) {
    const loss = Math.min(w.resp_reminder_cap, totalReminders * w.resp_per_reminder);
    score -= loss; evidenceCount += totalReminders;
    factors.push({ key:'reminders_sent', count: totalReminders, impact: -loss });
  }
  // Recent client response (any doc received in last 14d)
  const recentResponse = (allDocsForClient || []).some(d => d.received_date && (daysAgo(d.received_date) || 0) <= 14);
  if (recentResponse) {
    score += w.resp_recent_response_bonus;
    factors.push({ key:'recent_response', count: 1, impact: w.resp_recent_response_bonus });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    clientId: String(clientId),
    responsivenessScore: score,
    confidence: evidenceCount < (coldStartMin || 5) ? 'low' : 'ok',
    factors
  };
}

async function computeForAll() {
  const [tasks, pendingDocs, allDocs, workflows, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    fetchAllDocs(),
    repos.WorkflowsRepo.list({ workflowType: ['VAT_Filing','CT_Filing'], status: 'active', limit: 5000 }),
    repos.WorkloadConfigRepo.getAll()
  ]);
  // Build per-client buckets
  const byClientTasks = {}; tasks.forEach(t => { (byClientTasks[t.client_external_id] = byClientTasks[t.client_external_id] || []).push(t); });
  const byClientDocs = {}; pendingDocs.forEach(d => { (byClientDocs[d.client_external_id] = byClientDocs[d.client_external_id] || []).push(d); });
  const byClientAllDocs = {}; (allDocs || []).forEach(d => { (byClientAllDocs[d.client_external_id] = byClientAllDocs[d.client_external_id] || []).push(d); });

  // Stalled client-confirmation steps per client (batched fetch)
  const stalledByClient = {};
  const stepsByWf = await repos.WorkflowStepsRepo.listForWorkflows(workflows.map(w => w.id));
  workflows.forEach(wf => {
    const steps = stepsByWf[wf.id] || [];
    const confirm = steps.find(s => s.step_key === 'Client_Confirmation_Obtained');
    if (confirm && confirm.status === 'in_progress') {
      // Use last_status_change proxy via wf.updated_at; fall back to 0.
      const inProgressDays = daysAgo(wf.updated_at) || 0;
      if (inProgressDays > 7) {
        (stalledByClient[wf.client_external_id] = stalledByClient[wf.client_external_id] || []).push({ workflowId: wf.id, days: inProgressDays });
      }
    }
  });

  const clients = repos.ClientsRepo.listAll();
  return clients.map(c => computeOne({
    clientId: c.id,
    tasks: byClientTasks[String(c.id)] || [],
    docs: byClientDocs[String(c.id)] || [],
    allDocsForClient: byClientAllDocs[String(c.id)] || [],
    confirmStepsInProgress: stalledByClient[String(c.id)] || []
  }, cfg, cfg.portfolio_cold_start_min));
}

// Helper: pull all doc requests (not just pending) to detect recent responses.
async function fetchAllDocs() {
  const { getClient } = require('../../supabase');
  const c = getClient(); if (!c) return [];
  const { data } = await c.from('compliance_document_requests').select('*').limit(10000);
  return data || [];
}

module.exports = { computeForAll, computeOne };
