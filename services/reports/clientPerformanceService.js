// Client Performance — per-client report. Aggregates over existing data;
// identifies high-maintenance, high-risk, and frequently-delayed clients.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');
const riskService = require('../riskService');
const clientReadinessService = require('../clientReadinessService');

const COLUMNS = [
  'clientName','owner','readinessState','tasksCompletedInPeriod','tasksOverdue',
  'documentsPending','escalationsInPeriod','healthScore','escalationScore','escalationBand',
  'filingsDue','filingsFiled','filingTimelinessPct',
  'isHighMaintenance','isHighRisk','isFrequentlyDelayed'
];

const DAY = 24 * 60 * 60 * 1000;
function pctile(arr, p) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }

async function generate(period, value) {
  const b = periodHelper.resolveBounds(period, value);
  const clients = repos.ClientsRepo.listAll();
  const [allTasks, pendingDocs, escalationsInPeriod, obligationsInPeriod, riskData, readinessData] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.EscalationEventsRepo.listBetween(b.fromISO, b.toISO),
    repos.ObligationsRepo.listBetween(b.fromDate, b.toDate),
    riskService.runAll(),
    clientReadinessService.getAllClientReadiness()
  ]);
  const readinessByClient = {}; (readinessData.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });
  const escalationScores = riskService.computeClientScores(riskData.findings, riskData.config, clients);
  const escByClient = {}; escalationScores.forEach(s => { escByClient[String(s.clientId)] = s; });

  // Pre-bucket
  const tasksByClient = {}; allTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });
  const docsByClient = {}; pendingDocs.forEach(d => { (docsByClient[d.client_external_id] = docsByClient[d.client_external_id] || []).push(d); });
  const oblByClient = {}; obligationsInPeriod.forEach(o => { (oblByClient[o.client_external_id] = oblByClient[o.client_external_id] || []).push(o); });

  // Frequently delayed: tasks completed in last 90d with sla_status='breached' > 50%
  const ninety = new Date(Date.now() - 90 * DAY).toISOString();

  const rows = clients.map(c => {
    const cid = String(c.id);
    const tasks = tasksByClient[cid] || [];
    const completedInPeriod = tasks.filter(t => t.completed_date && t.completed_date >= b.fromISO && t.completed_date < b.toISO);
    const overdue = tasks.filter(t => t.status !== 'completed' && t.due_date && new Date(t.due_date).getTime() < Date.now());
    const esc = escByClient[cid] || { score: 0, band: 'green', totals: { critical: 0, high: 0 } };
    const readiness = readinessByClient[cid] || null;

    // SLA delay rate over last 90d
    const recentCompleted = tasks.filter(t => t.completed_date && t.completed_date >= ninety);
    const breached = recentCompleted.filter(t => t.sla_status === 'breached').length;
    const delayRate = recentCompleted.length >= 3 ? breached / recentCompleted.length : null;

    // Filing performance for the period from obligations
    const periodObl = oblByClient[cid] || [];
    const filed = periodObl.filter(o => o.status === 'filed');
    const filedOnTime = filed.filter(o => o.filed_at && o.filing_deadline && new Date(o.filed_at) <= new Date(o.filing_deadline + 'T23:59:59Z')).length;
    const filingTimelinessPct = periodObl.length ? Math.round((filedOnTime / periodObl.length) * 100) : null;

    const escalationsInPeriodCount = escalationsInPeriod.filter(e => tasks.some(t => t.id === e.task_id)).length;

    return {
      clientId: c.id, clientName: c.name,
      owner: c.assignedTeam || null,
      readinessState: readiness ? readiness.state : 'idle',
      tasksCompletedInPeriod: completedInPeriod.length,
      tasksOverdue: overdue.length,
      documentsPending: (docsByClient[cid] || []).length,
      escalationsInPeriod: escalationsInPeriodCount,
      healthScore: null, // computed lazily on demand; left null in bulk report to keep this fast
      escalationScore: esc.score, escalationBand: esc.band,
      filingsDue: periodObl.length,
      filingsFiled: filed.length,
      filingTimelinessPct,
      _delayRate: delayRate
    };
  });

  // Derive flags
  const completedInPeriodVals = rows.map(r => r.tasksCompletedInPeriod).filter(v => v > 0);
  const p90Completed = pctile(completedInPeriodVals, 90);

  rows.forEach(r => {
    r.isHighRisk = r.escalationBand === 'red';
    r.isHighMaintenance = p90Completed != null && r.tasksCompletedInPeriod >= p90Completed && completedInPeriodVals.length >= 5;
    r.isFrequentlyDelayed = r._delayRate != null && r._delayRate >= 0.5;
    delete r._delayRate;
  });
  rows.sort((a, b2) => (b2.escalationScore || 0) - (a.escalationScore || 0));

  return { meta: b, columns: COLUMNS, rows };
}

module.exports = { generate, COLUMNS };
