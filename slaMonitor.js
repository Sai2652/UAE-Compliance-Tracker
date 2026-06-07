// SLA Monitor — derives sla_status on tasks. Persisted back to the row so the
// existing list endpoints can filter on it cheaply.
const { getClient } = require('./supabase');
const compliance = require('./compliance');

const DAY = 24 * 60 * 60 * 1000;
function days(a, b) { return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / DAY); }

async function getPolicies() {
  const c = getClient(); if (!c) return {};
  const { data } = await c.from('compliance_sla_policies').select('*');
  const map = {};
  (data || []).forEach(p => { map[p.task_type] = p; });
  return map;
}

function statusFor(task, policy) {
  if (!task.due_date) return 'on_track';
  const today = new Date();
  const due = new Date(task.due_date);
  const daysLeft = days(due, today);

  if (task.status === 'completed') {
    if (task.completed_date && task.target_completion_date) {
      return new Date(task.completed_date) <= new Date(task.target_completion_date) ? 'met' : 'breached';
    }
    return 'met';
  }
  if (daysLeft < 0) return 'breached';
  const breach = (policy && policy.breach_threshold_days) || 0;
  const atRisk = (policy && policy.at_risk_threshold_days) || 7;
  if (daysLeft <= breach) return 'likely_breach';
  // "likely_breach" = task not started or waiting and close to due
  if (daysLeft <= atRisk && ['not_started','waiting_documents','blocked'].includes(task.status)) return 'likely_breach';
  if (daysLeft <= atRisk) return 'at_risk';
  return 'on_track';
}

async function recomputeAll() {
  const policies = await getPolicies();
  const tasks = await compliance.tasks.list({ limit: 5000 });
  const updates = [];
  for (const t of tasks) {
    const sla = statusFor(t, policies[t.task_type]);
    if (sla !== t.sla_status) updates.push({ id: t.id, sla_status: sla });
  }
  if (!updates.length) return { scanned: tasks.length, updated: 0 };
  const c = getClient();
  const chunks = [];
  for (let i = 0; i < updates.length; i += 100) chunks.push(updates.slice(i, i + 100));
  for (const ch of chunks) {
    await Promise.all(ch.map(u => c.from('compliance_tasks').update({ sla_status: u.sla_status }).eq('id', u.id)));
  }
  return { scanned: tasks.length, updated: updates.length };
}

module.exports = { recomputeAll, statusFor, getPolicies };
