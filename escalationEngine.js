// Escalation Engine — periodically scans open tasks against configured rules
// in compliance_escalation_rules. When a rule matches, records an event in
// compliance_escalation_events (dedupe per task+rule still open), bumps task
// escalation_level / status, and dispatches notifications via email.js.

const compliance = require('./compliance');
const { store, users, activity } = require('./database');
const roles = require('./roles');
const email = require('./email');
const { EscalationRulesRepo, EscalationEventsRepo } = require('./repositories');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return Math.floor((Date.now() - new Date(d).getTime()) / DAY); }
function daysUntil(d) { return Math.floor((new Date(d).getTime() - Date.now()) / DAY); }

async function loadRules() {
  try { return await EscalationRulesRepo.listActive(); }
  catch (e) { console.warn('[escalation] loadRules:', e.message); return []; }
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
  try { return await EscalationEventsRepo.hasOpenFor(taskId, ruleId); }
  catch (e) { console.warn('[escalation] hasOpenEventFor:', e.message); return false; }
}

// Everyone who should receive a morning digest: the manager and every team
// lead. Each one gets their own scope, not the same firm-wide list.
function digestRecipients() {
  return (store.users || []).filter(u => u.active === 1 && u.email && roles.atLeast(u, 'admin'));
}

// How far up the reporting line a given severity should reach.
//   1 → the owner only
//   2 → the owner and their team lead
//   3+ → the owner, their lead, and the manager
// Before this, notify_admin meant "every admin", so a stuck job belonging to
// one executive was mailed to both team leads and the manager at once. The
// point of a hierarchy is that a problem climbs one rung at a time.
function chainDepthFor(severity) {
  const s = Number(severity) || 1;
  if (s <= 1) return 1;
  if (s === 2) return 2;
  return 3;
}

async function recordEvent(task, rule) {
  const notified = [];
  const chain = roles.escalationChain(task.assigned_user_name, store.users || []);
  const depth = chainDepthFor(rule.severity);

  for (let i = 0; i < chain.length && i < depth; i++) {
    const person = chain[i];
    if (!person || !person.email) continue;
    // The owner gets the "your task" wording; anyone above gets the manager one.
    const isOwner = i === 0 && person.name === task.assigned_user_name;
    if (isOwner && !rule.notify_owner) continue;
    if (!isOwner && !rule.notify_admin) continue;
    const r = isOwner
      ? await email.sendEscalationOwnerEmail(person.email, person.name, task, rule)
      : await email.sendEscalationAdminEmail(person.email, person.name, task, rule);
    if (r && r.success) notified.push((isOwner ? 'owner:' : roles.labelOf(person.role) + ':') + person.email);
  }
  await EscalationEventsRepo.create({
    task_id: task.id, rule_id: rule.id, rule_name: rule.name,
    severity: rule.severity, notified: notified
  });
  // Record the escalation WITHOUT touching the work status.
  //
  // This used to set status = 'escalated', which overwrote whatever the task
  // actually was — not_started, in_progress, waiting_documents — so once a
  // sweep had run you could no longer tell what had been started. With 235
  // tasks every single one read 'escalated' and the board carried no signal at
  // all. Escalation is a separate dimension and escalation_level already holds
  // it, so the two no longer fight over one field.
  const patch = {
    escalation_level: (task.escalation_level || 0) + 1,
    last_escalated_at: new Date().toISOString(),
    last_escalated_rule: rule.name || null,
    last_escalated_severity: Number(rule.severity) || 1
  };
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

// The morning digest: what's overdue and what's stuck. Sent once a day to the
// manager and to each team lead — but scoped, so a lead sees their own team's
// work rather than the whole firm's. A digest full of another team's clients is
// a digest that gets ignored.
async function dailyAdminDigests() {
  const todayStr = new Date().toISOString().slice(0,10);
  const overdue = await compliance.tasks.list({ overdue: true, limit: 500 });
  // "Stuck" is now escalation_level plus a hand-set blocked status, which no
  // status query can express — so list the open tasks and filter.
  const openTasks = await compliance.tasks.list({ notStatus: ['completed'], limit: 5000 });
  const blocked = openTasks.filter(compliance.isStuck);
  if (!overdue.length && !blocked.length) return { sent: 0 };

  const allUsers = store.users || [];
  const clients = ((store.trackerData || {}).clients) || [];
  let sent = 0;

  for (const person of digestRecipients()) {
    const scope = roles.clientScope(person, allUsers);
    const mineIds = new Set(
      (scope.all ? clients : clients.filter(c => roles.scopeAllows(scope, c.assignedTeam)))
        .map(c => String(c.id))
    );
    const inScope = (t) => scope.all || mineIds.has(String(t.client_external_id));
    const myOverdue = overdue.filter(inScope);
    const myBlocked = blocked.filter(inScope);
    if (!myOverdue.length && !myBlocked.length) continue;   // nothing to say to them

    const r = await email.sendAdminDigest(person.email, person.name, {
      overdue: myOverdue, blocked: myBlocked, date: todayStr
    });
    if (r && r.success) sent++;
  }
  return { sent };
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
