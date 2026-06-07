// Manager Command Center — single payload for the 30-second view.
// Composes other services; designed to be cheap-to-recompute on each request.
const repos = require('../repositories');
const capacity = require('./capacityService');
const forecast = require('./forecastService');
const reviewQueue = require('./reviewQueueService');
const healthScore = require('../healthScore');

const DAY = 24 * 60 * 60 * 1000;

async function getCommandCenter() {
  const [capDash, fc, rq, openEsc, allTasks, allDocs, clients] = await Promise.all([
    capacity.getCapacityDashboard(),
    forecast.getForecast(14),
    reviewQueue.getQueue(),
    repos.EscalationEventsRepo.listOpen(),
    repos.TasksRepo.listOpen({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    Promise.resolve(repos.ClientsRepo.listAll())
  ]);

  // Top 10 priority clients = top sum of priority_score across each client's open tasks.
  const byClient = {};
  allTasks.forEach(t => {
    const key = t.client_external_id;
    if (!byClient[key]) byClient[key] = { clientId: key, clientName: t.client_name, totalPriority: 0, openTasks: 0, overdue: 0 };
    byClient[key].totalPriority += (t.priority_score || 0);
    byClient[key].openTasks += 1;
    if (t.due_date && new Date(t.due_date).getTime() < Date.now()) byClient[key].overdue += 1;
  });
  const topPriorityClients = Object.values(byClient).sort((a, b) => b.totalPriority - a.totalPriority).slice(0, 10);

  // Critical deadlines: open tasks due within next 7 days, sorted ascending.
  const sevenOut = new Date(Date.now() + 7 * DAY).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  const criticalDeadlines = allTasks
    .filter(t => t.due_date && t.due_date <= sevenOut)
    .sort((a,b) => (a.due_date || '').localeCompare(b.due_date || ''))
    .slice(0, 15);

  // Overloaded employees (re-use capacity dashboard rows)
  const overloaded = capDash.rows.filter(r => r.band === 'overloaded');

  // Missing docs > 7d
  const docsStale = allDocs.filter(d => (Date.now() - new Date(d.requested_date).getTime()) > 7 * DAY);

  // High-risk clients via health
  const health = await healthScore.computeForAll(clients);
  const highRisk = health.filter(h => h.band === 'at_risk' || h.band === 'critical').slice(0, 10);

  // Review bottlenecks
  const reviewBottlenecks = rq.oldest;

  // Capacity warnings = forecast warnings
  const capacityWarnings = fc.warnings;

  // Actionable insight strings (instead of raw counts)
  const insights = [];
  if (overloaded.length) insights.push(`${overloaded.length} team member(s) overloaded — see Workload tab.`);
  if (rq.countsByAging.alarm > 0) insights.push(`${rq.countsByAging.alarm} review(s) waiting > ${rq.countsByAging.alarm > 1 ? 'a week' : 'days'}.`);
  if (docsStale.length) insights.push(`${docsStale.length} document request(s) stuck for over a week.`);
  if (capacityWarnings.length) capacityWarnings.forEach(w => insights.push(w.message));
  if (highRisk.length) insights.push(`${highRisk.length} client(s) in at-risk or critical health band.`);
  if (openEsc.length) insights.push(`${openEsc.length} open escalation event(s).`);

  return {
    insights,
    topPriorityClients,
    criticalDeadlines,
    escalationRisks: openEsc.slice(0, 15),
    overloadedEmployees: overloaded,
    missingDocuments: docsStale.slice(0, 15),
    highRiskClients: highRisk,
    reviewBottlenecks,
    capacityWarnings,
    forecastSummary: { next7d: fc.next7d, next30d: fc.next30d, dailyCapacity: fc.dailyCapacity }
  };
}

module.exports = { getCommandCenter };
