// Employee Performance — per-user metrics aligned to calendar periods.
// Reuses the data shape from productivityService but with calendar bounds.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');

const DAY = 24 * 60 * 60 * 1000;

const COLUMNS = [
  'userName','assignedClients','openTasks','completedTasks','overdueTasks',
  'completedInPeriod','avgCompletionDays','pendingReviews','escalationsGenerated','slaAdherencePct'
];

async function generate(period, value) {
  const b = periodHelper.resolveBounds(period, value);
  const [tasks, escalations, users] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.EscalationEventsRepo.listBetween(b.fromISO, b.toISO),
    Promise.resolve(repos.UsersRepo.listActive())
  ]);
  const clients = repos.ClientsRepo.listAll();

  // Bucket tasks by assignee
  const byUser = {};
  users.forEach(u => { byUser[u.id] = { user: u, tasks: [] }; });
  tasks.forEach(t => { if (t.assigned_user_id != null && byUser[t.assigned_user_id]) byUser[t.assigned_user_id].tasks.push(t); });

  const rows = users.map(u => {
    const myTasks = byUser[u.id].tasks;
    const open = myTasks.filter(t => t.status !== 'completed');
    const completed = myTasks.filter(t => t.status === 'completed');
    const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now());
    const completedInPeriod = completed.filter(t => t.completed_date && t.completed_date >= b.fromISO && t.completed_date < b.toISO);
    const dur = completedInPeriod.filter(t => t.created_date).map(t => (new Date(t.completed_date) - new Date(t.created_date)) / DAY);
    const avgCompletionDays = dur.length ? Math.round((dur.reduce((a, x) => a + x, 0) / dur.length) * 10) / 10 : null;
    const pendingReviews = open.filter(t => t.status === 'ready_for_review').length;
    const escalationsGenerated = escalations.filter(e => myTasks.some(t => t.id === e.task_id)).length;
    const cohort = completedInPeriod.filter(t => ['met','breached'].includes(t.sla_status));
    const slaAdherencePct = cohort.length ? Math.round((cohort.filter(t => t.sla_status === 'met').length / cohort.length) * 100) : null;
    const assignedClients = clients.filter(c => c.assignedTeam === u.name).length;
    return {
      userId: u.id, userName: u.name,
      assignedClients,
      openTasks: open.length,
      completedTasks: completed.length,
      overdueTasks: overdue.length,
      completedInPeriod: completedInPeriod.length,
      avgCompletionDays,
      pendingReviews,
      escalationsGenerated,
      slaAdherencePct
    };
  }).sort((a, b2) => b2.completedInPeriod - a.completedInPeriod);

  return { meta: b, columns: COLUMNS, rows };
}

module.exports = { generate, COLUMNS };
