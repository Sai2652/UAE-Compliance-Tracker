// Productivity Analytics — per-user metrics across time windows.
const repos = require('../repositories');

const DAY = 24 * 60 * 60 * 1000;
const RANGE_DAYS = { '7': 7, '30': 30, '90': 90 };

function rangeBounds(range) {
  const days = RANGE_DAYS[String(range)] || 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY);
  return { fromISO: from.toISOString(), toISO: to.toISOString(), days };
}

async function getForUser(userId, range) {
  return computeForOne(parseInt(userId, 10), range);
}

async function getForAll(range) {
  const users = repos.UsersRepo.listActive();
  const rows = await Promise.all(users.map(u => computeForOne(u.id, range)));
  return rows.sort((a, b) => b.tasksCompleted - a.tasksCompleted);
}

async function computeForOne(userId, range) {
  const { fromISO, toISO, days } = rangeBounds(range);
  const [tasks, reviews, escalations] = await Promise.all([
    repos.TasksRepo.listByAssignee(userId, { limit: 5000 }),
    repos.ReviewEventsRepo.listBetween(fromISO, toISO),
    repos.EscalationEventsRepo.listBetween(fromISO, toISO)
  ]);
  const u = repos.UsersRepo.findById(userId) || { id: userId, name: 'User ' + userId };

  const completed = tasks.filter(t => t.status === 'completed' && t.completed_date && t.completed_date >= fromISO && t.completed_date <= toISO);
  const durations = completed.filter(t => t.created_date).map(t => (new Date(t.completed_date).getTime() - new Date(t.created_date).getTime()) / DAY);
  const avgDuration = durations.length ? Math.round((durations.reduce((a,b)=>a+b,0) / durations.length) * 10) / 10 : null;

  // SLA adherence among completed in window
  const cohort = completed.filter(t => ['met','breached'].includes(t.sla_status));
  const slaPct = cohort.length ? Math.round((cohort.filter(t => t.sla_status === 'met').length / cohort.length) * 100) : null;

  // Review acceptance — only reviews where reviewer = user (this user reviewed work)
  // AND review acceptance for tasks owned by this user (their work got reviewed).
  // Phase 3 spec: "Review acceptance rate" per employee = % of their submitted reviews approved.
  const myReviewsAsSubmitter = reviews.filter(r => {
    const t = tasks.find(x => x.id === r.task_id); // task that this user owned
    return !!t;
  });
  const submitterApproved = myReviewsAsSubmitter.filter(r => r.decision === 'approve').length;
  const submitterTotal = myReviewsAsSubmitter.length;
  const reviewAcceptanceRate = submitterTotal >= 3
    ? Math.round((submitterApproved / submitterTotal) * 100)
    : null;

  // Escalations attributed to current owner (approximation; documented).
  const escalationsForUser = escalations.filter(e => {
    const t = tasks.find(x => x.id === e.task_id);
    return !!t;
  }).length;

  // Completed by type
  const byType = {};
  completed.forEach(t => { byType[t.task_type] = (byType[t.task_type] || 0) + 1; });
  const completedByType = Object.entries(byType).map(([type, count]) => ({ type, count })).sort((a,b) => b.count - a.count);

  return {
    userId: u.id, userName: u.name,
    rangeDays: days,
    tasksCompleted: completed.length,
    avgCompletionDays: avgDuration,
    slaAdherencePct: slaPct,
    reviewAcceptanceRate,
    escalations: escalationsForUser,
    completedByType
  };
}

module.exports = { getForUser, getForAll };
