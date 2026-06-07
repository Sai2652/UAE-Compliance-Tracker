// Escalation Engine — periodically scans open tasks against configured rules
// in compliance_escalation_rules. When a rule matches, records an event in
// compliance_escalation_events (dedupe per task+rule still open), bumps task
// escalation_level / status, and dispatches notifications via email.js.

const { getClient } = require('./supabase');
const compliance = require('./compliance');
const { store, users, activity } = require('./database');
const email = require('./email');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return Math.floor((Date.now() - new Date(d).getTime()) / DAY); }
function daysUntil(d) { return Math.floor((new Date(d).getTime() - Date.now()) / DAY); }

async function loadRules() {
  const c = getClient(); if (!c) return [];
  const { data } = await c.from('compliance_escalation_rules').select('*').eq('active', true);
  return data || [];
}

function matches(rule, task, openDocsByClient) {
  const td = rule.threshold_days;
  switch (rule.condition_type) {
    case 'no_updates':
      if (['completed','reviewed'].includes(task.status)) return false;
      return task.last_activity_at && daysAgo(task.last_activity_at) >= td;
    case 'docs_pending':
      if (task.status !== 'waiting_documents') return false;
      const docs = openDocsByClient[task.client_external_id] || [];
      return docs.some(d => daysAgo(d.requested_date) >= td);
    case 'review_backlog':
      if (task.status !== 'ready_for_review') return false;
      return task.last_status_change && daysAgo(task.last_status_change) >= td;
    case 'not_started':
      if (task.status !== 'not_started' || !task.due_date) return false;
      return daysUntil(task.due_date) <= td;
    case 'deadline_approaching':
      if (['completed','reviewed'].includes(task.status)) return false;
      if (!task.due_date) return false;
      return daysUntil(task.due_date) <= td && daysUntil(task.due_date) >= 0;
    default: return false;
  }
}

async function hasOpenEventFor(taskId, ruleId) {
  const c = getClient();
  const { data } = await c.from('compliance_escalation_events').select('id')
    .eq('task_id', taskId).eq('rule_id', ruleId).is('resolved_at', null).limit(1);
  return (data || []).length > 0;
}

function findUserByName(name) {
  return (store.users || []).find(u => u.name === name);
}

function adminEmails() {
  return (store.users || []).filter(u => u.role === 'admin' && u.active === 1).map(u => u.email);
}

async function recordEvent(task, rule) {
  const c = getClient();
  const notified = [];
  // owner notify
  if (rule.notify_owner && task.assigned_user_name) {
    const u = findUserByName(task.assigned_user_name);
    if (u && u.email) {
      const r = await email.sendEscalationOwnerEmail(u.email, u.name, task, rule);
      if (r && r.success) notified.push('owner:' + u.email);
    }
  }
  if (rule.notify_admin) {
    for (const ae of adminEmails()) {
      const r = await email.sendEscalationAdminEmail(ae, 'Admin', task, rule);
      if (r && r.success) notified.push('admin:' + ae);
    }
  }
  await c.from('compliance_escalation_events').insert({
    task_id: task.id, rule_id: rule.id, rule_name: rule.name,
    severity: rule.severity, notified
  });
  // bump task escalation_level + maybe status
  const patch = { escalation_level: (task.escalation_level || 0) + 1, last_escalated_at: new Date().toISOString() };
  if (rule.severity >= 2 && !['escalated','blocked','completed'].includes(task.status)) {
    patch.status = 'escalated';
  }
  await compliance.tasks.update(task.id, patch);
  activity.log(0, 'system', 'task_escalated', `Task ${task.id} — ${rule.name}`);
}

async function runSweep() {
  const rules = await loadRules();
  if (!rules.length) return { matched: 0 };
  const tasks = await compliance.tasks.list({ notStatus: ['completed'], limit: 5000 });
  const docs = await compliance.documents.list({ status: 'pending', limit: 5000 });
  const byClient = {};
  docs.forEach(d => { (byClient[d.client_external_id] = byClient[d.client_external_id] || []).push(d); });
  let matched = 0;
  for (const t of tasks) {
    for (const r of rules) {
      if (!matches(r, t, byClient)) continue;
      if (await hasOpenEventFor(t.id, r.id)) continue;
      await recordEvent(t, r);
      matched++;
    }
  }
  return { matched, scannedTasks: tasks.length, rules: rules.length };
}

// Independently notify on overdue tasks + blocked tasks (admin), once per day per task.
async function dailyAdminDigests() {
  const c = getClient(); if (!c) return;
  const today = new Date().toISOString().slice(0,10);
  const todayStr = new Date().toISOString().slice(0,10);
  const overdue = await compliance.tasks.list({ overdue: true, limit: 200 });
  const blocked = await compliance.tasks.list({ status: ['blocked','escalated'], limit: 200 });
  if (!overdue.length && !blocked.length) return;
  for (const ae of adminEmails()) {
    await email.sendAdminDigest(ae, 'Admin', { overdue, blocked, date: todayStr });
  }
}

function startScheduler() {
  if (process.env.ESCALATION_ENGINE_ENABLED === 'false') return;
  const minutes = parseFloat(process.env.ESCALATION_SWEEP_MINUTES || '60');
  setTimeout(() => runSweep().catch(e => console.error('[escalation] sweep:', e.message)), 12000);
  setInterval(() => runSweep().catch(e => console.error('[escalation] sweep:', e.message)), minutes * 60 * 1000);
  // Daily digest at next 09:00 local, then every 24h
  const now = new Date();
  const next9 = new Date(now); next9.setHours(9,0,0,0);
  if (next9 <= now) next9.setDate(next9.getDate() + 1);
  setTimeout(function loop() {
    dailyAdminDigests().catch(e => console.error('[escalation] digest:', e.message));
    setTimeout(loop, 24 * 60 * 60 * 1000);
  }, next9.getTime() - now.getTime());
}

module.exports = { runSweep, dailyAdminDigests, startScheduler };
