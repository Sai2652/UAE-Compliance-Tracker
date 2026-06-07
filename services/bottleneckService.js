// Bottleneck analysis — detects firm-wide congestion in specific workflow
// stages. Outputs root causes, top contributors, and a suggested owner
// (lowest-workload admin).
const repos = require('../repositories');
const capacity = require('./capacityService');
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function getBottlenecks() {
  const [tasks, docs, cfg, capDash] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.WorkloadConfigRepo.getAll(),
    capacity.getCapacityDashboard()
  ]);
  const minItems = cfg.bottleneck_min_items || 3;

  const idleAdmin = (capDash.rows || [])
    .filter(r => r.userId && r.band !== 'overloaded')
    .sort((a,b) => (a.workloadRatio||0) - (b.workloadRatio||0))[0];
  const suggestedOwner = idleAdmin ? { id: idleAdmin.userId, name: idleAdmin.userName, ratio: idleAdmin.workloadRatio } : null;

  const buckets = [
    bucket('review', 'Internal Review', tasks.filter(t => t.status === 'ready_for_review' && (daysAgo(t.submitted_for_review_at || t.last_status_change) || 0) >= cfg.review_aging_warn_days)),
    bucket('accounting', 'Accounting', tasks.filter(t => t.task_type === 'Accounting_Bookkeeping' && t.status !== 'completed' && (daysAgo(t.created_date) || 0) >= 7)),
    bucket('registration', 'Registrations', tasks.filter(t => (t.task_type === 'VAT_Registration' || t.task_type === 'CT_Registration') && t.status !== 'completed' && (daysAgo(t.created_date) || 0) >= cfg.risk_registration_high_days)),
    bucket('client_approval', 'Client Approvals', tasks.filter(t => t.status === 'blocked' && (daysAgo(t.last_status_change) || 0) >= 3)),
    bucketDocs('documents', 'Documents', docs.filter(d => (daysAgo(d.requested_date) || 0) >= cfg.risk_docs_pending_medium))
  ];

  return {
    suggestedOwner,
    bottlenecks: buckets
      .map(b => Object.assign(b, { isBottleneck: b.count >= minItems }))
      .sort((a,b) => b.count - a.count)
  };
}

function bucket(key, label, items) {
  const topClients = {};
  items.forEach(t => { topClients[t.client_name] = (topClients[t.client_name] || 0) + 1; });
  const contributors = Object.entries(topClients)
    .sort((a,b) => b[1] - a[1]).slice(0, 3)
    .map(([name, count]) => ({ name, count }));
  const oldest = items.length
    ? Math.max(...items.map(t => daysAgo(t.last_status_change || t.created_date) || 0))
    : 0;
  return { key, label, count: items.length, oldestDays: oldest, topClients: contributors };
}
function bucketDocs(key, label, items) {
  const topClients = {};
  items.forEach(d => { topClients[d.client_name] = (topClients[d.client_name] || 0) + 1; });
  const contributors = Object.entries(topClients).sort((a,b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));
  const oldest = items.length ? Math.max(...items.map(d => daysAgo(d.requested_date) || 0)) : 0;
  return { key, label, count: items.length, oldestDays: oldest, topClients: contributors };
}

module.exports = { getBottlenecks };
