// Escalation analytics — categories, aging, root causes.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');
const DAY = 24 * 60 * 60 * 1000;

const COLUMNS = [
  'taskId','clientName','ruleName','category','severity','triggeredAt','resolvedAt','ageDays','status'
];

// Map rule_name → root cause category for "what's actually causing escalations".
function categorize(ruleName) {
  const n = (ruleName || '').toLowerCase();
  if (n.includes('document')) return 'Missing Documents';
  if (n.includes('review'))   return 'Delayed Review';
  if (n.includes('confirm'))  return 'Client Confirmation Pending';
  if (n.includes('registration')) return 'Registration Delay';
  if (n.includes('not started')) return 'Work Not Started';
  if (n.includes('deadline')) return 'Deadline Approaching';
  if (n.includes('activity')) return 'No Activity';
  return 'Other';
}

async function generate(period, value) {
  const b = periodHelper.resolveBounds(period, value);
  const events = await repos.EscalationEventsRepo.listBetween(b.fromISO, b.toISO);
  const tasks = await repos.TasksRepo.listAll({ limit: 5000 });
  const tasksById = {}; tasks.forEach(t => { tasksById[t.id] = t; });

  const now = Date.now();
  const rows = events.map(e => {
    const t = tasksById[e.task_id] || {};
    const trig = new Date(e.triggered_at).getTime();
    const resolved = e.resolved_at ? new Date(e.resolved_at).getTime() : null;
    const age = resolved ? Math.floor((resolved - trig) / DAY) : Math.floor((now - trig) / DAY);
    return {
      eventId: e.id, taskId: e.task_id,
      clientName: t.client_name || '',
      ruleName: e.rule_name || '',
      category: categorize(e.rule_name),
      severity: e.severity,
      triggeredAt: e.triggered_at.slice(0, 10),
      resolvedAt: e.resolved_at ? e.resolved_at.slice(0, 10) : null,
      ageDays: age,
      status: resolved ? 'resolved' : 'open'
    };
  }).sort((a, b2) => (b2.triggeredAt || '').localeCompare(a.triggeredAt));

  // Aggregates
  const created = rows.length;
  const resolved = rows.filter(r => r.status === 'resolved').length;
  const open = rows.filter(r => r.status === 'open').length;
  const byCategory = {};
  rows.forEach(r => { byCategory[r.category] = (byCategory[r.category] || 0) + 1; });
  const categories = Object.entries(byCategory).map(([k, v]) => ({ category: k, count: v })).sort((a, b2) => b2.count - a.count);

  const openAgeAvg = (function() {
    const o = rows.filter(r => r.status === 'open');
    return o.length ? Math.round((o.reduce((s, r) => s + r.ageDays, 0) / o.length) * 10) / 10 : null;
  })();
  const resolvedAgeAvg = (function() {
    const o = rows.filter(r => r.status === 'resolved');
    return o.length ? Math.round((o.reduce((s, r) => s + r.ageDays, 0) / o.length) * 10) / 10 : null;
  })();

  return {
    meta: b, columns: COLUMNS, rows,
    totals: { created, resolved, open, openAgeAvgDays: openAgeAvg, resolvedAgeAvgDays: resolvedAgeAvg },
    categories
  };
}

module.exports = { generate, COLUMNS, categorize };
