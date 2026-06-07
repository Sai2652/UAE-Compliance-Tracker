// Daily Briefing — the 30-second morning snapshot for managers.
const riskService = require('./riskService');
const repos = require('../repositories');
const DAY = 24 * 60 * 60 * 1000;

async function getBriefing() {
  const { findings } = await riskService.runAll();
  const cfg = await repos.WorkloadConfigRepo.getAll();
  const clientScores = riskService.computeClientScores(findings, cfg, repos.ClientsRepo.listAll());

  const today = new Date(); today.setUTCHours(0,0,0,0);
  const inWeek = new Date(today.getTime() + 7 * DAY);

  const [allTasks, docs] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending()
  ]);

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const topRisks = findings.slice().sort((a,b) => (order[a.level]||9) - (order[b.level]||9)).slice(0, 10);

  const topCriticalClients = clientScores.filter(c => c.band !== 'green').slice(0, 10);

  const deadlinesThisWeek = allTasks.filter(t => t.status !== 'completed' && t.due_date && new Date(t.due_date) >= today && new Date(t.due_date) <= inWeek)
    .sort((a,b) => (a.due_date || '').localeCompare(b.due_date || ''));

  const overdue = allTasks.filter(t => t.status !== 'completed' && t.due_date && new Date(t.due_date) < today);
  const pendingReviews = allTasks.filter(t => t.status === 'ready_for_review');

  return {
    topRisks,
    topCriticalClients,
    deadlinesThisWeek: deadlinesThisWeek.slice(0, 25),
    overdueCount: overdue.length,
    pendingReviewCount: pendingReviews.length,
    missingDocumentCount: docs.length,
    pendingReviewSample: pendingReviews.slice(0, 10),
    overdueSample: overdue.slice(0, 10),
    missingDocSample: docs.slice(0, 10)
  };
}

module.exports = { getBriefing };
