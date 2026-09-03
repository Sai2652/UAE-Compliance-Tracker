// Composite Client Risk Profile — rolls up Compliance, Operational and
// Responsiveness sub-risks into one band: Low | Medium | High | Critical.
const repos = require('../../repositories');
// isStuck/isEscalated read escalation_level rather than a status of
// 'escalated', which the sweep no longer sets.
const compliance = require('../../compliance');
const riskService = require('../riskService');
const healthScore = require('../../healthScore');
const clientReadinessService = require('../clientReadinessService');
const responsivenessSvc = require('./responsivenessScoreService');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }

async function computeForAll() {
  const [tasks, healthAll, readiness, riskData, respAll, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    healthScore.computeForAll(repos.ClientsRepo.listAll()),
    clientReadinessService.getAllClientReadiness(),
    riskService.runAll(),
    responsivenessSvc.computeForAll(),
    repos.WorkloadConfigRepo.getAll()
  ]);
  const clients = repos.ClientsRepo.listAll();
  const clientScores = riskService.computeClientScores(riskData.findings, riskData.config, clients);

  const byClient = {};
  clientScores.forEach(s => { byClient[String(s.clientId)] = s; });
  const readinessByClient = {}; (readiness.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });
  const healthByClient = {}; healthAll.forEach(h => { healthByClient[String(h.clientId)] = h; });
  const respByClient = {}; respAll.forEach(r => { respByClient[r.clientId] = r; });

  const taskByClient = {}; tasks.forEach(t => { (taskByClient[t.client_external_id] = taskByClient[t.client_external_id] || []).push(t); });

  const medium = Number(cfg.risk_band_medium) || 25;
  const high = Number(cfg.risk_band_high) || 50;
  const critical = Number(cfg.risk_band_critical) || 75;
  function band(v) {
    if (v >= critical) return 'critical';
    if (v >= high) return 'high';
    if (v >= medium) return 'medium';
    return 'low';
  }

  return clients.map(c => {
    const cid = String(c.id);
    const myTasks = taskByClient[cid] || [];
    const open = myTasks.filter(t => t.status !== 'completed');
    const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now()).length;
    const dueSoon = open.filter(t => { const d = daysUntil(t.due_date); return d != null && d >= 0 && d <= 7; }).length;
    const openEscalations = open.filter(t => compliance.isEscalated(t)).length;

    // Compliance Risk: weight by upcoming deadlines, overdue, and missing registrations.
    let complianceRisk = Math.min(100,
      overdue * 12 + dueSoon * 6 +
      (myTasks.some(t => t.task_type === 'CT_Registration' && t.status !== 'completed') ? 20 : 0) +
      (myTasks.some(t => t.task_type === 'VAT_Registration' && t.status !== 'completed') ? 10 : 0)
    );

    // Operational Risk: derived from health (inverted) + open escalations
    const h = healthByClient[cid];
    const operationalRisk = Math.min(100, Math.round(((h ? 100 - h.score : 30) * 0.6) + openEscalations * 12));

    // Responsiveness Risk: 100 − responsiveness_score
    const r = respByClient[cid];
    const responsivenessRisk = r ? (100 - r.responsivenessScore) : 30;

    const overall = Math.max(complianceRisk, operationalRisk, responsivenessRisk);
    const riskBand = band(overall);

    return {
      clientId: cid,
      complianceRisk: Math.round(complianceRisk),
      operationalRisk,
      responsivenessRisk,
      overallRisk: Math.round(overall),
      riskBand
    };
  });
}

module.exports = { computeForAll };
