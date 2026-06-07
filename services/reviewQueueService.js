// Review Operations Center.
const repos = require('../repositories');
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function getQueue() {
  const [tasks, config] = await Promise.all([
    repos.TasksRepo.listAwaitingReview({ limit: 500 }),
    repos.WorkloadConfigRepo.getAll()
  ]);
  // sort oldest first (by submitted_for_review_at fallback to last_status_change)
  const list = tasks.slice().sort((a,b) => {
    const aT = a.submitted_for_review_at || a.last_status_change;
    const bT = b.submitted_for_review_at || b.last_status_change;
    return new Date(aT).getTime() - new Date(bT).getTime();
  }).map(t => {
    const submitted = t.submitted_for_review_at || t.last_status_change;
    const age = daysAgo(submitted);
    let aging = 'fresh';
    if (age >= config.review_aging_alarm_days) aging = 'alarm';
    else if (age >= config.review_aging_warn_days) aging = 'warn';
    return {
      id: t.id, client: t.client_name, taskType: t.task_type, owner: t.assigned_user_name,
      priority: t.priority_score, submittedAt: submitted, ageDays: age, aging
    };
  });

  const oldest10 = list.slice(0, 10);
  const counts = { fresh: 0, warn: 0, alarm: 0 };
  list.forEach(r => counts[r.aging]++);

  // Turnaround stats from last 30 days of review events.
  const fromISO = new Date(Date.now() - 30 * DAY).toISOString();
  const toISO = new Date().toISOString();
  const events = await repos.ReviewEventsRepo.listBetween(fromISO, toISO);
  const turnarounds = events.map(e => e.turnaround_seconds).filter(s => typeof s === 'number');
  const avgTurnaroundHours = turnarounds.length
    ? Math.round((turnarounds.reduce((a,b) => a + b, 0) / turnarounds.length / 3600) * 10) / 10
    : null;

  // Reviewer workload (admins only — only admins can review today).
  const admins = repos.UsersRepo.listAdmins();
  const reviewerWorkload = admins.map(a => {
    const reviewed = events.filter(e => e.reviewer_user_id === a.id).length;
    return { userId: a.id, userName: a.name, reviewsLast30d: reviewed };
  }).sort((a,b) => b.reviewsLast30d - a.reviewsLast30d);

  return {
    queueDepth: list.length,
    countsByAging: counts,
    oldest: oldest10,
    queue: list,
    avgTurnaroundHours,
    reviewerWorkload
  };
}

module.exports = { getQueue };
