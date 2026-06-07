// Client Insight Panel — per-client narrative: status, risks, missing items,
// upcoming deadlines, recommended next actions. Composes existing services.
const repos = require('../../repositories');
const clientSettings = require('../portfolio/clientSettingsService');
const clientReadinessService = require('../clientReadinessService');
const healthScore = require('../../healthScore');
const riskService = require('../riskService');
const readinessService = require('../readinessService');
const explain = require('./explanationEngine');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d)   { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function generate(clientId) {
  const cid = String(clientId);
  const client = repos.ClientsRepo.findById(cid);
  if (!client) return null;
  const [tasks, docs, obligations, settings, readinessAll, healthData, riskData, workflows] = await Promise.all([
    repos.TasksRepo.listByClient(cid, { limit: 1000 }),
    repos.DocumentsRepo.listForClient(cid),
    repos.ObligationsRepo.list({ clientId: cid, limit: 500 }),
    clientSettings.get(cid),
    clientReadinessService.getAllClientReadiness().then(d => (d.clients || []).find(r => String(r.clientId) === cid) || null),
    healthScore.computeForClient(client).catch(() => null),
    riskService.runAll(),
    repos.WorkflowsRepo.list({ clientId: cid, limit: 100 })
  ]);

  const myFindings = (riskData.findings || []).filter(f => String(f.clientId) === cid);
  const clientScores = riskService.computeClientScores(riskData.findings, riskData.config, [client]);
  const escalation = clientScores[0] || { score: 0, band: 'green' };

  // Status sentence
  const statusSentences = [];
  statusSentences.push(`${client.name} (Tier ${settings.tier}) is ${escalation.band.toUpperCase()} risk with escalation score ${escalation.score}.`);
  if (readinessAll) statusSentences.push(explain.explainReadiness(readinessAll));
  if (healthData) statusSentences.push(`Health score ${healthData.score} (${healthData.band}).`);

  // Open risks
  const openRisks = explain.sortByImpact(myFindings).slice(0, 5).map(f => ({
    level: f.level, kind: f.kind, sentence: explain.explainFinding(f), taskId: f.taskId
  })).filter(r => r.sentence);

  // Missing items
  const missingItems = (docs || []).filter(d => d.status === 'pending').map(d => ({
    docId: d.id, documentName: d.document_name, pendingDays: daysAgo(d.requested_date),
    sentence: `Missing "${d.document_name}" — pending ${daysAgo(d.requested_date)}d, ${d.reminder_count || 0} reminder(s) sent.`
  }));

  // Upcoming deadlines (next 30d)
  const upcoming = (obligations || []).filter(o => {
    if (!o.filing_deadline || o.status === 'filed') return false;
    const d = daysUntil(o.filing_deadline); return d != null && d >= 0 && d <= 30;
  }).map(o => ({
    obligationId: o.id, label: o.period_label, type: o.obligation_type,
    deadline: o.filing_deadline, daysLeft: daysUntil(o.filing_deadline),
    sentence: `${o.obligation_type.replace(/_/g,' ')} ${o.period_label} due ${o.filing_deadline} (${daysUntil(o.filing_deadline)}d).`
  }));

  // Recommended next actions
  const actions = recommendActions({ client, tasks, docs, settings, readinessAll, workflows, findings: myFindings });

  return {
    client: { id: client.id, name: client.name, tier: settings.tier, partnerOwner: settings.partnerOwner, owner: client.assignedTeam || null },
    status: statusSentences,
    healthScore: healthData,
    escalation,
    openRisks,
    missingItems,
    upcomingDeadlines: upcoming,
    recommendedActions: actions
  };
}

function recommendActions({ client, tasks, docs, settings, readinessAll, workflows, findings }) {
  const actions = [];

  // 1. Awaiting client approval
  if (readinessAll && readinessAll.state === 'awaiting_client_approval') {
    actions.push({ kind: 'awaiting_client_approval', sentence: explain.recommendedAction('awaiting_client_approval', { clientName: client.name }) });
  }
  // 2. Stale documents
  (docs || []).filter(d => d.status === 'pending').sort((a,b) => (a.requested_date||'').localeCompare(b.requested_date||'')).slice(0, 2).forEach(d => {
    const days = (Date.now() - new Date(d.requested_date).getTime()) / 86400000;
    if (days > 7) {
      actions.push({ kind: 'missing_document', docId: d.id, sentence: explain.recommendedAction('missing_document', { clientName: client.name, documentName: d.document_name, days: Math.floor(days) }) });
    }
  });
  // 3. Filing due not ready
  (tasks || []).filter(t => t.status !== 'completed' && t.due_date).slice().sort((a,b) => (a.due_date||'').localeCompare(b.due_date||'')).slice(0, 3).forEach(t => {
    const days = (new Date(t.due_date).getTime() - Date.now()) / 86400000;
    if (days >= 0 && days <= 7 && (t.task_type === 'VAT_Filing' || t.task_type === 'CT_Filing')) {
      actions.push({ kind: 'filing_due_not_ready', taskId: t.id, sentence: explain.recommendedAction('filing_due_not_ready', { clientName: client.name, workflowType: t.task_type, daysToDue: Math.floor(days) }) });
    }
  });
  // 4. Review backlog
  (tasks || []).filter(t => t.status === 'ready_for_review').forEach(t => {
    const ageDays = Math.floor((Date.now() - new Date(t.submitted_for_review_at || t.last_status_change).getTime()) / 86400000);
    if (ageDays >= 3) {
      actions.push({ kind: 'review_backlog', taskId: t.id, sentence: explain.recommendedAction('review_backlog', { clientName: client.name, taskType: t.task_type, ageDays }) });
    }
  });
  // 5. Registration pending
  (tasks || []).filter(t => t.status !== 'completed' && (t.task_type === 'VAT_Registration' || t.task_type === 'CT_Registration')).forEach(t => {
    const days = Math.floor((Date.now() - new Date(t.created_date).getTime()) / 86400000);
    actions.push({ kind: 'registration_pending', taskId: t.id, sentence: explain.recommendedAction('registration_pending', { clientName: client.name, kind: t.task_type.replace(/_/g,' '), days }) });
  });
  // 6. Overdue
  (tasks || []).filter(t => t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < Date.now()).forEach(t => {
    actions.push({ kind: 'deadline_overdue', taskId: t.id, sentence: explain.recommendedAction('deadline_overdue', { clientName: client.name }) });
  });

  // Dedupe by kind+target, cap at 5
  const seen = new Set(); const out = [];
  for (const a of actions) {
    const k = a.kind + ':' + (a.taskId || a.docId || '0');
    if (seen.has(k)) continue; seen.add(k); out.push(a);
    if (out.length >= 5) break;
  }
  return out;
}

async function explainRisk(clientId) {
  const insight = await generate(clientId);
  if (!insight) return null;
  return {
    clientId: insight.client.id, clientName: insight.client.name,
    riskBand: insight.escalation.band, riskScore: insight.escalation.score,
    reasons: insight.openRisks.map(r => r.sentence),
    recommendedActions: insight.recommendedActions.map(a => a.sentence)
  };
}

module.exports = { generate, explainRisk };
