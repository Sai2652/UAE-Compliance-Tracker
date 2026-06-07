// Client Communication Tracker.
// "Last communication" is derived from existing data:
//   max(last task comment, last document request, last task activity)
// per client. No new persistence.

const repos = require('../repositories');
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function getCommunicationBoard() {
  const clients = repos.ClientsRepo.listAll();
  const [allTasks, allDocs, config] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.DocumentsRepo.listPending(),
    repos.WorkloadConfigRepo.getAll()
  ]);
  // Map task -> client
  const tasksByClient = {};
  allTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });

  // Pull last-comment per task in one round-trip
  const taskIds = allTasks.map(t => t.id);
  const lastCommentByTask = await repos.CommentsRepo.lastCommentByTask(taskIds);

  const docsByClient = {};
  allDocs.forEach(d => { (docsByClient[d.client_external_id] = docsByClient[d.client_external_id] || []).push(d); });

  const rows = clients.map(c => {
    const tasks = tasksByClient[String(c.id)] || [];
    const docs = docsByClient[String(c.id)] || [];

    const lastTaskActivity = tasks.reduce((max, t) => {
      const v = t.last_activity_at;
      return (!max || (v && v > max)) ? v : max;
    }, null);

    const lastComment = tasks.reduce((max, t) => {
      const c = lastCommentByTask[t.id];
      const v = c && c.created_at;
      return (!max || (v && v > max)) ? v : max;
    }, null);

    const lastDocRequest = docs.reduce((max, d) => {
      const v = d.requested_date;
      return (!max || (v && v > max)) ? v : max;
    }, null);

    const lastCommunication = [lastTaskActivity, lastComment, lastDocRequest].filter(Boolean).sort().pop() || null;
    const silenceDays = daysAgo(lastCommunication);

    const pendingDocs = docs.filter(d => d.status === 'pending');
    const remindersCount = pendingDocs.reduce((s, d) => s + (d.reminder_count || 0), 0);

    const openTasks = tasks.filter(t => t.status !== 'completed').length;

    return {
      clientId: c.id, clientName: c.name, owner: c.assignedTeam || null,
      lastCommunication, silenceDays,
      lastDocRequest, pendingDocCount: pendingDocs.length, totalReminders: remindersCount,
      outstandingTasks: openTasks,
      silent: silenceDays !== null && silenceDays >= config.communication_silence_days
    };
  }).sort((a, b) => {
    // Silent first (longest silence), then nulls (never contacted)
    if (a.lastCommunication === null && b.lastCommunication !== null) return -1;
    if (b.lastCommunication === null && a.lastCommunication !== null) return 1;
    return (a.lastCommunication || '').localeCompare(b.lastCommunication || '');
  });

  return { clients: rows, silenceThresholdDays: config.communication_silence_days };
}

module.exports = { getCommunicationBoard };
