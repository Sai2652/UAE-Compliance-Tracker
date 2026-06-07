// Capacity & Workload — pure business logic.
// Equal-weight model (Phase 3 decision): all open tasks count equally toward
// capacity. Default capacity = 20 open tasks per user, overridable per user.

const repos = require('../repositories');

const DAY = 24 * 60 * 60 * 1000;
function daysFromNow(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function loadContext() {
  const [tasks, capacityRows, config, users] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.UserCapacityRepo.getAll(),
    repos.WorkloadConfigRepo.getAll(),
    Promise.resolve(repos.UsersRepo.listActive())
  ]);
  const capacityByUserId = {};
  capacityRows.forEach(r => { capacityByUserId[r.user_id] = r; });
  return { tasks, capacityByUserId, config, users };
}

function capacityFor(userId, capacityByUserId, defaultCapacity) {
  const row = capacityByUserId[userId];
  if (row && row.capacity_open_tasks) return row.capacity_open_tasks;
  return defaultCapacity;
}

function bandFor(ratio, cfg) {
  if (ratio === null || ratio === undefined) return 'unknown';
  if (ratio <= cfg.band_underutilized_max) return 'underutilized';
  if (ratio >= cfg.band_overloaded_min) return 'overloaded';
  return 'balanced';
}

// Group tasks by assigned_user_id (and a synthetic 'unassigned' bucket).
function bucketByOwner(tasks) {
  const buckets = {};
  for (const t of tasks) {
    const key = t.assigned_user_id == null ? 'unassigned' : String(t.assigned_user_id);
    if (!buckets[key]) buckets[key] = { userId: t.assigned_user_id, userName: t.assigned_user_name || 'Unassigned', tasks: [] };
    buckets[key].tasks.push(t);
  }
  return buckets;
}

function summarizeBucket(bucket, clients) {
  const tasks = bucket.tasks;
  const open = tasks.filter(t => t.status !== 'completed');
  const completed = tasks.filter(t => t.status === 'completed');
  const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now());
  const awaitingReview = open.filter(t => t.status === 'ready_for_review');
  const blocked = open.filter(t => t.status === 'blocked' || t.status === 'escalated');
  const dueSoon = open.filter(t => { const d = daysFromNow(t.due_date); return d !== null && d >= 0 && d <= 7; });

  const completionDurations = completed
    .filter(t => t.created_date && t.completed_date)
    .map(t => (new Date(t.completed_date).getTime() - new Date(t.created_date).getTime()) / DAY);
  const avgCompletionDays = completionDurations.length
    ? Math.round((completionDurations.reduce((a, b) => a + b, 0) / completionDurations.length) * 10) / 10
    : null;

  const slaCohort = completed.filter(t => ['met','breached'].includes(t.sla_status));
  const slaMet = slaCohort.filter(t => t.sla_status === 'met').length;
  const slaAdherencePct = slaCohort.length ? Math.round((slaMet / slaCohort.length) * 100) : null;

  const assignedClientsCount = bucket.userName && clients
    ? clients.filter(c => c.assignedTeam === bucket.userName).length
    : null;

  return {
    userId: bucket.userId,
    userName: bucket.userName,
    assignedClients: assignedClientsCount,
    openTasks: open.length,
    completedTasks: completed.length,
    overdueTasks: overdue.length,
    awaitingReview: awaitingReview.length,
    blockedTasks: blocked.length,
    dueWithin7d: dueSoon.length,
    avgCompletionDays,
    slaAdherencePct
  };
}

async function getCapacityDashboard() {
  const ctx = await loadContext();
  const clients = repos.ClientsRepo.listAll();
  const buckets = bucketByOwner(ctx.tasks);
  // Make sure every active user shows up, even with zero tasks.
  ctx.users.forEach(u => {
    const k = String(u.id);
    if (!buckets[k]) buckets[k] = { userId: u.id, userName: u.name, tasks: [] };
  });
  const rows = Object.values(buckets).map(b => {
    const summary = summarizeBucket(b, clients);
    summary.capacity = b.userId == null ? null : capacityFor(b.userId, ctx.capacityByUserId, ctx.config.default_capacity_open_tasks);
    summary.workloadRatio = summary.capacity ? Math.round((summary.openTasks / summary.capacity) * 100) / 100 : null;
    summary.band = bandFor(summary.workloadRatio, ctx.config);
    return summary;
  });
  // Sort: overloaded first, then balanced by ratio desc, then underutilized.
  const order = { overloaded: 0, balanced: 1, underutilized: 2, unknown: 3 };
  rows.sort((a, b) => (order[a.band] - order[b.band]) || ((b.workloadRatio || 0) - (a.workloadRatio || 0)));
  return { rows, config: ctx.config };
}

// Recommendations: take overloaded users with > capacity, move lowest-priority
// unstarted tasks to underutilized users. Each rec has reason text.
async function getWorkloadRecommendations(maxRecs) {
  const { rows, config } = await getCapacityDashboard();
  const overloaded = rows.filter(r => r.band === 'overloaded' && r.userId);
  const under = rows.filter(r => r.band === 'underutilized' && r.userId)
    .sort((a, b) => (a.workloadRatio || 0) - (b.workloadRatio || 0));

  const recs = [];
  for (const o of overloaded) {
    if (recs.length >= (maxRecs || 8)) break;
    const target = under.shift(); // pick the most underutilized
    if (!target) break;
    const targetCap = target.capacity || config.default_capacity_open_tasks;
    const oCap = o.capacity || config.default_capacity_open_tasks;
    // How many tasks to move to bring both inside the balanced band?
    const overflow = o.openTasks - Math.floor(oCap * 1.0);
    const headroom = Math.floor(targetCap * 1.0) - target.openTasks;
    const toMove = Math.max(1, Math.min(overflow, headroom));
    if (toMove <= 0) continue;

    // Find best candidate tasks to suggest moving: not_started, lowest priority first,
    // belonging to the overloaded user.
    const taskCandidates = (await repos.TasksRepo.listByAssignee(o.userId, { notStatus: ['completed'], limit: 500 }))
      .filter(t => t.status === 'not_started')
      .sort((a, b) => (a.priority_score || 0) - (b.priority_score || 0))
      .slice(0, toMove);

    recs.push({
      kind: 'reassign_tasks',
      fromUserId: o.userId, fromUserName: o.userName,
      toUserId: target.userId, toUserName: target.userName,
      count: taskCandidates.length || toMove,
      taskIds: taskCandidates.map(t => t.id),
      reason: `${o.userName} workload ratio ${o.workloadRatio} (overloaded); ${target.userName} ratio ${target.workloadRatio} (underutilized). Moving ${taskCandidates.length || toMove} task(s) brings ${o.userName} closer to balanced.`
    });
  }

  // If there are unassigned tasks AND any user has headroom, surface those first.
  const unassigned = rows.find(r => r.userName === 'Unassigned');
  if (unassigned && unassigned.openTasks > 0) {
    const sink = rows.filter(r => r.userId && r.band !== 'overloaded')
      .sort((a, b) => (a.workloadRatio || 0) - (b.workloadRatio || 0))[0];
    if (sink) {
      recs.unshift({
        kind: 'assign_unassigned',
        toUserId: sink.userId, toUserName: sink.userName,
        count: unassigned.openTasks,
        reason: `${unassigned.openTasks} unassigned task(s); ${sink.userName} has spare capacity (ratio ${sink.workloadRatio || 0}).`
      });
    }
  }

  return { recommendations: recs };
}

module.exports = { getCapacityDashboard, getWorkloadRecommendations, bandFor };
