// Portfolio Dashboard — single composite payload combining every per-client
// score plus tier into one sortable row. The Portfolio UI reads this directly.
const repos = require('../../repositories');
// isStuck/isEscalated read escalation_level rather than a status of
// 'escalated', which the sweep no longer sets.
const compliance = require('../../compliance');
const healthScore = require('../../healthScore');
const clientReadinessService = require('../clientReadinessService');
const clientSettings = require('./clientSettingsService');
const responsivenessSvc = require('./responsivenessScoreService');
const effortSvc = require('./effortScoreService');
const serviceQualitySvc = require('./serviceQualityScoreService');
const riskProfileSvc = require('./clientRiskProfileService');

const DAY = 24 * 60 * 60 * 1000;

async function getDashboard() {
  const clients = repos.ClientsRepo.listAll();
  const [tasks, pendingDocs, settingsMap, healthAll, readiness, resp, eff, sq, risk] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    clientSettings.getAllAsMap(),
    healthScore.computeForAll(clients),
    clientReadinessService.getAllClientReadiness(),
    responsivenessSvc.computeForAll(),
    effortSvc.computeForAll(),
    serviceQualitySvc.computeForAll(),
    riskProfileSvc.computeForAll()
  ]);

  const byClientTasks = {}; tasks.forEach(t => { (byClientTasks[t.client_external_id] = byClientTasks[t.client_external_id] || []).push(t); });
  const byClientDocs = {}; pendingDocs.forEach(d => { (byClientDocs[d.client_external_id] = byClientDocs[d.client_external_id] || []).push(d); });
  void byClientDocs; // used downstream
  const healthByClient = {}; healthAll.forEach(h => { healthByClient[String(h.clientId)] = h; });
  const readinessByClient = {}; (readiness.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });
  const respByClient = {}; resp.forEach(r => { respByClient[r.clientId] = r; });
  const effByClient = {}; eff.forEach(r => { effByClient[r.clientId] = r; });
  const sqByClient = {}; sq.forEach(r => { sqByClient[r.clientId] = r; });
  const riskByClient = {}; risk.forEach(r => { riskByClient[r.clientId] = r; });

  const rows = clients.map(c => {
    const cid = String(c.id);
    const tlist = byClientTasks[cid] || [];
    const open = tlist.filter(t => t.status !== 'completed');
    const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now());
    const upcoming7d = open.filter(t => t.due_date && (() => { const d = Math.floor((new Date(t.due_date).getTime() - Date.now()) / DAY); return d >= 0 && d <= 7; })()).length;
    const lastActivity = tlist.reduce((max, t) => (!max || (t.last_activity_at && t.last_activity_at > max)) ? t.last_activity_at : max, null);
    const docsPending = (byClientDocs[cid] || []).length;
    const h = healthByClient[cid] || { score: null, band: 'unknown' };
    const r = riskByClient[cid] || { riskBand: 'low', overallRisk: 0, complianceRisk: 0, operationalRisk: 0, responsivenessRisk: 0 };
    const s = settingsMap[cid] || { tier: 'B', partnerOwner: null };
    const escalationsOpen = open.filter(t => compliance.isEscalated(t)).length;

    return {
      clientId: c.id, clientName: c.name, owner: c.assignedTeam || null,
      tier: s.tier, partnerOwner: s.partnerOwner,
      healthScore: h.score, healthBand: h.band,
      readinessState: (readinessByClient[cid] && readinessByClient[cid].state) || 'idle',
      openTasks: open.length, overdueTasks: overdue.length,
      openEscalations: escalationsOpen,
      documentsPending: docsPending,
      upcomingDeadlines: upcoming7d,
      lastActivity,
      responsivenessScore: (respByClient[cid] || {}).responsivenessScore || null,
      effortScore: (effByClient[cid] || {}).effortScore || null,
      isHighMaintenance: !!(effByClient[cid] && effByClient[cid].isHighMaintenance),
      serviceQualityScore: (sqByClient[cid] || {}).serviceQualityScore || null,
      complianceRisk: r.complianceRisk, operationalRisk: r.operationalRisk, responsivenessRisk: r.responsivenessRisk,
      overallRisk: r.overallRisk, riskBand: r.riskBand
    };
  });

  // Sort by overall risk desc by default
  rows.sort((a, b) => (b.overallRisk || 0) - (a.overallRisk || 0));
  return { rows, columns: [
    'clientName','tier','partnerOwner','riskBand','overallRisk','healthScore','readinessState',
    'openTasks','overdueTasks','openEscalations','documentsPending','upcomingDeadlines',
    'responsivenessScore','effortScore','serviceQualityScore','isHighMaintenance','lastActivity'
  ]};
}

// Per-client portfolio payload (used by the client detail "Service Governance" card).
async function getForClient(clientId) {
  const cid = String(clientId);
  const dashboard = await getDashboard();
  const row = dashboard.rows.find(r => String(r.clientId) === cid) || null;
  const settings = await clientSettings.get(cid);
  return { row, settings };
}

module.exports = { getDashboard, getForClient };
