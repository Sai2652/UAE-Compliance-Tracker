// Key Client Alerts — comparative detection of clients trending negatively.
// Rolling 30d vs prior 30d, using existing timestamps. No snapshots needed.
const repos = require('../../repositories');
const DAY = 24 * 60 * 60 * 1000;

async function generate() {
  const now = Date.now();
  const recentFrom  = new Date(now - 30 * DAY).toISOString();
  const recentTo    = new Date(now).toISOString();
  const priorFrom   = new Date(now - 60 * DAY).toISOString();
  const priorTo     = recentFrom;
  const ninetyAgo   = new Date(now - 90 * DAY).toISOString();

  const [tasks, escRecent, escPrior, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.EscalationEventsRepo.listBetween(recentFrom, recentTo),
    repos.EscalationEventsRepo.listBetween(priorFrom, priorTo),
    repos.WorkloadConfigRepo.getAll()
  ]);
  const tasksById = {}; tasks.forEach(t => { tasksById[t.id] = t; });
  const floor = Number(cfg.alert_escalation_floor) || 2;
  const ratio = Number(cfg.alert_escalation_ratio) || 2;
  const repeatDelayMin = Number(cfg.alert_repeat_delay_min) || 3;

  const escCountBy = events => events.reduce((acc, e) => {
    const t = tasksById[e.task_id]; if (!t) return acc;
    const k = String(t.client_external_id); acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  const recentEsc = escCountBy(escRecent);
  const priorEsc  = escCountBy(escPrior);

  // SLA breaches in last 90d
  const breachBy = {};
  tasks.filter(t => t.status === 'completed' && t.completed_date && t.completed_date >= ninetyAgo && t.sla_status === 'breached').forEach(t => {
    const k = String(t.client_external_id); breachBy[k] = (breachBy[k] || 0) + 1;
  });

  const clients = repos.ClientsRepo.listAll();
  const alerts = [];

  clients.forEach(c => {
    const cid = String(c.id);
    const cur = recentEsc[cid] || 0;
    const prev = priorEsc[cid] || 0;
    if (cur >= floor && (prev === 0 ? true : cur / prev >= ratio)) {
      alerts.push({
        kind: 'increasing_escalations',
        clientId: c.id, clientName: c.name,
        severity: cur >= floor * 2 ? 'high' : 'medium',
        evidence: `${cur} escalation(s) in last 30d vs ${prev} prior 30d`,
        recommendation: 'Review root cause and partner involvement.'
      });
    }
    if ((breachBy[cid] || 0) >= repeatDelayMin) {
      alerts.push({
        kind: 'repeated_delays',
        clientId: c.id, clientName: c.name,
        severity: 'high',
        evidence: `${breachBy[cid]} SLA breach(es) in last 90d`,
        recommendation: 'Reassess client effort and tier; consider intervention.'
      });
    }
  });

  // Cross-reference risk service for "becoming high risk"
  const riskService = require('../riskService');
  const riskData = await riskService.runAll();
  const scores = riskService.computeClientScores(riskData.findings, riskData.config, clients);
  scores.forEach(s => {
    // Heuristic: surface red-band clients whose escalation activity is also recent.
    if (s.band === 'red' && (recentEsc[String(s.clientId)] || 0) > 0) {
      alerts.push({
        kind: 'becoming_high_risk',
        clientId: s.clientId, clientName: s.clientName,
        severity: 'high',
        evidence: `Escalation score ${s.score} with ${recentEsc[String(s.clientId)] || 0} recent escalation(s).`,
        recommendation: 'Schedule client review; consider Tier A reclassification.'
      });
    }
  });

  // Dedupe by (kind, clientId)
  const seen = new Set();
  const deduped = alerts.filter(a => {
    const k = a.kind + ':' + a.clientId; if (seen.has(k)) return false; seen.add(k); return true;
  });

  return { alerts: deduped };
}

module.exports = { generate };
