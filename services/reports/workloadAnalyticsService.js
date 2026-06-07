// Workload analytics sliced by employee, client, or compliance type.
const repos = require('../../repositories');
const capacityService = require('../capacityService');

async function generate(slice) {
  const sl = (slice || 'user').toLowerCase();
  const tasks = await repos.TasksRepo.listAll({ limit: 5000 });
  const open = tasks.filter(t => t.status !== 'completed');

  if (sl === 'client') {
    const map = {};
    open.forEach(t => {
      const k = t.client_external_id || 'unknown';
      map[k] = map[k] || { clientName: t.client_name || 'Unknown', openTasks: 0, byType: {} };
      map[k].openTasks++;
      map[k].byType[t.task_type] = (map[k].byType[t.task_type] || 0) + 1;
    });
    const rows = Object.values(map).map(r => ({
      clientName: r.clientName, openTasks: r.openTasks,
      topType: Object.entries(r.byType).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    })).sort((a, b) => b.openTasks - a.openTasks);
    return { slice: 'client', columns: ['clientName','openTasks','topType'], rows };
  }
  if (sl === 'type') {
    const map = {};
    open.forEach(t => { map[t.task_type] = (map[t.task_type] || 0) + 1; });
    const rows = Object.entries(map).map(([type, count]) => ({ type, openTasks: count })).sort((a, b) => b.openTasks - a.openTasks);
    return { slice: 'type', columns: ['type','openTasks'], rows };
  }
  // default: employee
  const cap = await capacityService.getCapacityDashboard();
  return {
    slice: 'user',
    columns: ['userName','band','openTasks','capacity','workloadRatio','overdueTasks','awaitingReview'],
    rows: (cap.rows || []).map(r => ({
      userName: r.userName, band: r.band,
      openTasks: r.openTasks, capacity: r.capacity,
      workloadRatio: r.workloadRatio,
      overdueTasks: r.overdueTasks, awaitingReview: r.awaitingReview
    }))
  };
}

// Resource concentration risk — flags when one user holds > 50% of a single
// client's open tasks (indicates bus-factor risk).
async function concentrationRisks() {
  const tasks = await repos.TasksRepo.listAll({ limit: 5000 });
  const open = tasks.filter(t => t.status !== 'completed' && t.assigned_user_id);
  const byClient = {};
  open.forEach(t => {
    const k = t.client_external_id;
    byClient[k] = byClient[k] || { clientName: t.client_name, total: 0, byUser: {} };
    byClient[k].total++;
    byClient[k].byUser[t.assigned_user_name || 'Unassigned'] = (byClient[k].byUser[t.assigned_user_name || 'Unassigned'] || 0) + 1;
  });
  const out = [];
  Object.values(byClient).forEach(r => {
    if (r.total < 3) return;
    const top = Object.entries(r.byUser).sort((a, b) => b[1] - a[1])[0];
    if (top && (top[1] / r.total) > 0.5) {
      out.push({ clientName: r.clientName, userName: top[0], userShare: Math.round(top[1] / r.total * 100), openTasks: r.total });
    }
  });
  return out.sort((a, b) => b.userShare - a.userShare);
}

module.exports = { generate, concentrationRisks };
