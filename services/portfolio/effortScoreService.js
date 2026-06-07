// Effort Score (0-100). Higher = more firm effort required.
const repos = require('../../repositories');
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function computeForAll() {
  const ninety = new Date(Date.now() - 90 * DAY).toISOString();
  const [tasks, pendingDocs, escalations, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.EscalationEventsRepo.listBetween(ninety, new Date().toISOString()),
    repos.WorkloadConfigRepo.getAll()
  ]);
  const tasksById = {}; tasks.forEach(t => { tasksById[t.id] = t; });
  const escClientCount = {};
  escalations.forEach(e => {
    const t = tasksById[e.task_id]; if (!t) return;
    const k = String(t.client_external_id);
    escClientCount[k] = (escClientCount[k] || 0) + 1;
  });

  const byClientTasks = {}; tasks.forEach(t => { (byClientTasks[t.client_external_id] = byClientTasks[t.client_external_id] || []).push(t); });
  const byClientDocs = {};  pendingDocs.forEach(d => { (byClientDocs[d.client_external_id] = byClientDocs[d.client_external_id] || []).push(d); });

  const clients = repos.ClientsRepo.listAll();
  return clients.map(c => {
    const cid = String(c.id);
    const t = byClientTasks[cid] || [];
    const open = t.filter(x => x.status !== 'completed');
    const overdue = open.filter(x => x.due_date && new Date(x.due_date).getTime() < Date.now()).length;
    const staleDocs = (byClientDocs[cid] || []).filter(d => (daysAgo(d.requested_date) || 0) > 7).length;
    const escCount = escClientCount[cid] || 0;

    let score = 0;
    const f = [];
    const add = (key, count, weight, cap) => { if (!count) return; const v = Math.min(cap, count * weight); score += v; f.push({ key, count, impact: v }); };
    add('open_tasks',        open.length, Number(cfg.effort_per_open_task) || 1.5, Number(cfg.effort_open_cap) || 40);
    add('escalations_90d',   escCount,   Number(cfg.effort_per_escalation_90d) || 5, Number(cfg.effort_esc_cap) || 30);
    add('stale_docs',        staleDocs,  Number(cfg.effort_per_stale_doc) || 4, Number(cfg.effort_doc_cap) || 20);
    add('overdue',           overdue,    Number(cfg.effort_per_overdue) || 4, Number(cfg.effort_overdue_cap) || 25);

    score = Math.max(0, Math.min(100, Math.round(score)));
    const high = score >= (Number(cfg.effort_high_threshold) || 70);
    const low  = score <= (Number(cfg.effort_low_threshold) || 30);
    const evidence = open.length + escCount + staleDocs + overdue;
    return {
      clientId: cid,
      effortScore: score,
      isHighMaintenance: high,
      isLowMaintenance: low,
      confidence: evidence < (Number(cfg.portfolio_cold_start_min) || 5) ? 'low' : 'ok',
      factors: f
    };
  });
}

module.exports = { computeForAll };
