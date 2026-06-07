// AI Priority Engine — presentation over existing priority_score (already
// tier-weighted by taskEngine). Splits ranked work into three buckets and
// attaches rationale from the explanation engine.
//
// IMPORTANT: this layer does NOT recompute priority. The math lives in
// taskEngine.computePriorityScore. We only sort, slice, and explain.

const repos = require('../../repositories');
const clientSettings = require('../portfolio/clientSettingsService');
const clientReadinessService = require('../clientReadinessService');
const explain = require('./explanationEngine');

async function generate({ userId, isAdmin } = {}) {
  const [tasks, settingsMap, readinessData] = await Promise.all([
    isAdmin ? repos.TasksRepo.listOpen({ limit: 5000 }) : repos.TasksRepo.listByAssignee(userId, { notStatus: ['completed'], limit: 1000 }),
    clientSettings.getAllAsMap(),
    clientReadinessService.getAllClientReadiness().catch(() => ({ clients: [] }))
  ]);
  const readinessByClient = {}; (readinessData.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });

  const decorated = tasks.map(t => {
    const tier = (settingsMap[String(t.client_external_id)] || {}).tier || 'B';
    const readiness = readinessByClient[String(t.client_external_id)] || null;
    const rationale = explain.explainTask(t, {
      tier,
      readinessState: readiness ? readiness.state : null
    });
    return {
      taskId: t.id,
      clientId: t.client_external_id,
      clientName: t.client_name,
      owner: t.assigned_user_name,
      taskType: t.task_type,
      status: t.status,
      dueDate: t.due_date,
      priorityScore: t.priority_score || 0,
      slaStatus: t.sla_status,
      tier,
      readinessState: readiness ? readiness.state : null,
      rationale
    };
  }).sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  return {
    highest: decorated.slice(0, 10),
    next:    decorated.slice(10, 25),
    upcoming: decorated.slice(25, 50),
    totalRanked: decorated.length
  };
}

module.exports = { generate };
