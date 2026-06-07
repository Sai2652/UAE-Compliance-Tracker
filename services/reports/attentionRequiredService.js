// Top Attention Required Clients — composite ranking across the operational
// signals that most often demand a manager's intervention. Reused by both the
// Manager Command Center and the MIS Dashboard.
//
// Scoring (each capped to keep the formula stable):
//   high_risk (escalation band='red')        +50
//   awaiting_client_approval (readiness)     +30
//   missing docs > 7d pending                +5 each, cap +25
//   overdue tasks                            +8 each, cap +40
//   upcoming deadlines in next 7d            +5 each, cap +25
//
// Weights live in compliance_workload_config (attention_*) and fall back to
// the defaults above if absent.

const repos = require('../../repositories');
const riskService = require('../riskService');
const clientReadinessService = require('../clientReadinessService');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d)   { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function generate(limit) {
  const top = limit || 20;
  const [allTasks, pendingDocs, readinessData, riskData, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    clientReadinessService.getAllClientReadiness(),
    riskService.runAll(),
    repos.WorkloadConfigRepo.getAll()
  ]);
  const clients = repos.ClientsRepo.listAll();

  const w = {
    highRisk:                  cfg.attention_high_risk || 50,
    awaitingApproval:          cfg.attention_awaiting_approval || 30,
    perStaleDoc:               cfg.attention_per_stale_doc || 5,
    staleDocCap:               cfg.attention_stale_doc_cap || 25,
    perOverdueTask:            cfg.attention_per_overdue || 8,
    overdueCap:                cfg.attention_overdue_cap || 40,
    perUpcomingDeadline:       cfg.attention_per_upcoming || 5,
    upcomingCap:               cfg.attention_upcoming_cap || 25
  };

  const readinessByClient = {}; (readinessData.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });
  const escalationScores = riskService.computeClientScores(riskData.findings, riskData.config, clients);
  const escByClient = {}; escalationScores.forEach(s => { escByClient[String(s.clientId)] = s; });
  const tasksByClient = {}; allTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });
  const docsByClient = {}; pendingDocs.forEach(d => { (docsByClient[d.client_external_id] = docsByClient[d.client_external_id] || []).push(d); });

  const rows = clients.map(c => {
    const cid = String(c.id);
    const tasks = tasksByClient[cid] || [];
    const docs  = docsByClient[cid]  || [];
    const esc   = escByClient[cid]   || { band: 'green', score: 0 };
    const readiness = readinessByClient[cid] || { state: 'idle' };

    const isHighRisk = esc.band === 'red';
    const isAwaitingApproval = readiness.state === 'awaiting_client_approval';
    const staleDocs = docs.filter(d => (daysAgo(d.requested_date) || 0) > 7);
    const overdueOpen = tasks.filter(t => t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < Date.now());
    const upcomingOpen = tasks.filter(t => t.status !== 'completed' && t.due_date && (() => { const d = daysUntil(t.due_date); return d !== null && d >= 0 && d <= 7; })());

    const reasons = [];
    let score = 0;
    if (isHighRisk) { score += w.highRisk; reasons.push('High risk'); }
    if (isAwaitingApproval) { score += w.awaitingApproval; reasons.push('Awaiting client approval'); }
    if (staleDocs.length) { score += Math.min(w.staleDocCap, staleDocs.length * w.perStaleDoc); reasons.push(staleDocs.length + ' stale doc(s)'); }
    if (overdueOpen.length) { score += Math.min(w.overdueCap, overdueOpen.length * w.perOverdueTask); reasons.push(overdueOpen.length + ' overdue'); }
    if (upcomingOpen.length) { score += Math.min(w.upcomingCap, upcomingOpen.length * w.perUpcomingDeadline); reasons.push(upcomingOpen.length + ' due ≤7d'); }

    return {
      clientId: c.id, clientName: c.name,
      owner: c.assignedTeam || null,
      score, readinessState: readiness.state, escalationBand: esc.band,
      staleDocsCount: staleDocs.length,
      overdueCount: overdueOpen.length,
      upcomingDeadlineCount: upcomingOpen.length,
      reasons
    };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  return {
    columns: ['clientName','owner','score','readinessState','escalationBand','overdueCount','staleDocsCount','upcomingDeadlineCount','reasons'],
    rows
  };
}

module.exports = { generate };
