// Task Engine — priority scoring + automatic task generation.
//
// Generation rule: every compliance obligation on a client (VAT/CT due dates,
// registrations, audits, management reports, etc.) MUST have an operational
// task. We synthesize a deterministic `source_key` per (client, type, period)
// so re-running the generator is idempotent.

const { tasks, documents, config, generationRules } = require('./compliance');
const { tracker, users, activity } = require('./database');

const DAY = 24 * 60 * 60 * 1000;

function daysBetween(a, b) {
  return Math.floor((new Date(a).setHours(0,0,0,0) - new Date(b).setHours(0,0,0,0)) / DAY);
}
function toDateOnly(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0,10);
}

// ---------- Priority scoring ----------
async function computePriorityScore(task, weights, pendingDocsCountByClient) {
  const w = weights;
  let score = 0;
  const today = new Date();
  const due = task.due_date ? new Date(task.due_date) : null;
  const deadline = task.compliance_deadline ? new Date(task.compliance_deadline) : null;

  if (task.status === 'completed') return 0;

  if (due) {
    const daysToDue = daysBetween(due, today);
    if (daysToDue < 0) score += (w.overdue || 100) + Math.min(50, Math.abs(daysToDue));
    else if (daysToDue <= 7) score += (w.due_within_7d || 50);
  }
  if (deadline) {
    const daysToDeadline = daysBetween(deadline, today);
    if (daysToDeadline >= 0 && daysToDeadline <= 14) score += (w.compliance_deadline_within_14d || 40);
  }
  if (task.status === 'blocked' || task.status === 'escalated') score += (w.blocked || 30);

  const created = new Date(task.created_date);
  const pendingDays = Math.max(0, daysBetween(today, created));
  score += pendingDays * (w.pending_day || 2);

  if (task.status === 'ready_for_review') {
    const sinceChange = daysBetween(today, new Date(task.last_status_change));
    if (sinceChange > 3) score += (w.waiting_review_over_3d || 20);
  }
  if (task.status === 'waiting_documents') {
    const sinceChange = daysBetween(today, new Date(task.last_status_change));
    if (sinceChange > 7) score += (w.missing_docs_over_7d || 25);
    // also add if any doc request for this client is > 7d old
    const pending = (pendingDocsCountByClient[task.client_external_id] || []);
    const stale = pending.filter(d => daysBetween(today, new Date(d.requested_date)) > 7).length;
    if (stale > 0) score += stale * 5;
  }

  return Math.round(score);
}

async function recomputeAllPriorities() {
  const weights = await config.getAll();
  const open = await tasks.list({ notStatus: ['completed'], limit: 5000, orderBy: 'id' });
  // pre-bucket pending document requests by client
  const allDocs = await documents.list({ status: 'pending', limit: 5000 });
  const byClient = {};
  allDocs.forEach(d => { (byClient[d.client_external_id] = byClient[d.client_external_id] || []).push(d); });

  // Phase 7: pull tier multipliers per client (sparse — only rows where
  // admin has set a tier; default B = 1.0). Wrapped in try/catch so the
  // existing engine never breaks if the new table is missing.
  let tierByClient = {}; let multipliers = { A: 1.5, B: 1.0, C: 0.75 };
  try {
    const clientSettings = require('./services/portfolio/clientSettingsService');
    const map = await clientSettings.getAllAsMap();
    Object.keys(map).forEach(k => { tierByClient[k] = map[k].tier; });
    multipliers = await clientSettings.tierMultipliers();
  } catch (_) { /* table not migrated yet — fall back to B for everyone */ }

  const updates = [];
  for (const t of open) {
    const base = await computePriorityScore(t, weights, byClient);
    const tier = tierByClient[String(t.client_external_id)] || 'B';
    const score = Math.round(base * (multipliers[tier] || 1.0));
    if (score !== t.priority_score) updates.push({ id: t.id, priority_score: score });
  }
  if (updates.length) await tasks.bulkUpdatePriorities(updates);
  return { updated: updates.length, scanned: open.length };
}

// ---------- Generation engine ----------
// Resolve a user id by name (existing client.assignedTeam is a name string).
function resolveAssignee(name) {
  if (!name) return { id: null, name: null };
  const u = (require('./database').store.users || []).find(u => u.name === name && u.active === 1);
  return u ? { id: u.id, name: u.name } : { id: null, name };
}

// Build the deterministic key used to dedupe generated tasks.
function buildSourceKey(clientId, taskType, periodTag) {
  return `gen:${clientId}:${taskType}:${periodTag}`;
}

// Period tag derived from a date — e.g. 2026-Q2 for quarterly, 2026 for annual.
function periodTagFor(date, recurrence) {
  if (!date) return 'once';
  const d = new Date(date);
  if (isNaN(d)) return 'once';
  const y = d.getUTCFullYear();
  if (recurrence === 'annual')    return `${y}`;
  if (recurrence === 'quarterly') return `${y}-Q${Math.floor(d.getUTCMonth()/3)+1}`;
  if (recurrence === 'monthly')   return `${y}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  return `${y}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Read a namespaced field out of a nested client bag: ('ct', 'ctDueDate')
// resolves client.ct.dueDate. The UI writes camelCase keys inside client.vat /
// client.ct, while the generation rules name their triggers with the namespace
// prefixed ('ctDueDate'), so strip the prefix and restore camelCase to match.
//
// The previous version lowercased the whole remainder ('duedate') and then
// indexed with the unstripped field name — two separate bugs, so this fallback
// could never fire even though every client has client.ct.dueDate set.
function readNested(client, ns, field) {
  const bag = client[ns];
  if (!bag || typeof bag !== 'object') return null;
  const prefix = new RegExp('^' + ns, 'i');
  if (!prefix.test(field)) return null;
  const rest = field.replace(prefix, '');
  if (!rest) return null;
  const key = rest.charAt(0).toLowerCase() + rest.slice(1);
  const val = bag[key] !== undefined ? bag[key] : bag[rest];
  // Only scalars are dates. client.vat.periods / returnDates are arrays and
  // must not leak into new Date().
  return (typeof val === 'string' || typeof val === 'number') ? val : null;
}

// Gather candidate compliance deadlines from a client object. We look at the
// trigger_field defined per rule plus a few common fallback fields so the
// generator works against the existing client schema without requiring it to
// already have every field present.
function readDeadline(client, field) {
  if (!client) return null;
  // direct match
  if (client[field]) return client[field];
  // some clients store under nested vat/ct objects
  const nested = readNested(client, 'vat', field) || readNested(client, 'ct', field);
  if (nested) return nested;
  // generic fallbacks
  const fallback = {
    vatDueDate:   client.vatReturnDue || client.vatDue || null,
    ctDueDate:    client.ctReturnDue  || client.ctDue  || null,
    auditDueDate: client.auditDue     || null,
    reportingDate: client.reportingDue || null
  }[field];
  return fallback || null;
}

async function generateTasksForClient(client, rules) {
  const created = [];
  for (const rule of rules) {
    const deadlineRaw = readDeadline(client, rule.trigger_field);
    const deadline = toDateOnly(deadlineRaw);
    if (!deadline) continue;

    const dueDate = toDateOnly(new Date(new Date(deadline).getTime() - rule.lead_days * DAY));
    const periodTag = periodTagFor(deadline, rule.recurrence);
    const sourceKey = buildSourceKey(client.id, rule.task_type, periodTag);

    const existing = await tasks.findBySourceKey(sourceKey);
    if (existing) continue;

    const assignee = resolveAssignee(client.assignedTeam);
    const task = await tasks.create({
      clientId: client.id,
      clientName: client.name,
      taskType: rule.task_type,
      title: rule.default_title || rule.task_type.replace(/_/g, ' '),
      assignedUserId: assignee.id,
      assignedUserName: assignee.name,
      dueDate,
      complianceDeadline: deadline,
      source: 'generator',
      sourceKey,
      metadata: { rule_id: rule.id, period: periodTag, recurrence: rule.recurrence }
    });
    if (task) created.push(task);
  }
  return created;
}

async function runGenerationSweep() {
  const rules = await generationRules.listActive();
  if (!rules.length) return { created: 0, clients: 0 };
  const { clients } = tracker.getData();
  let createdCount = 0;
  for (const c of (clients || [])) {
    const created = await generateTasksForClient(c, rules);
    createdCount += created.length;
  }
  await recomputeAllPriorities();
  if (createdCount) {
    activity.log(0, 'system', 'tasks_generated', `Generated ${createdCount} task(s) across ${clients.length} client(s)`);
  }
  return { created: createdCount, clients: (clients || []).length };
}

// Schedule periodic sweep
function startScheduler() {
  if (process.env.TASK_GEN_ENABLED === 'false') return;
  const hours = parseFloat(process.env.TASK_GEN_INTERVAL_HOURS || '24');
  const ms = Math.max(1, hours) * 60 * 60 * 1000;
  // Run once shortly after boot, then on interval. Errors are logged but don't crash the app.
  setTimeout(() => runGenerationSweep().catch(e => console.error('[taskEngine] sweep error:', e.message)), 5000);
  setInterval(() => {
    runGenerationSweep().catch(e => console.error('[taskEngine] sweep error:', e.message));
  }, ms);
  // Re-score every hour even without new tasks (handles day-rollover).
  setInterval(() => {
    recomputeAllPriorities().catch(e => console.error('[taskEngine] rescore error:', e.message));
  }, 60 * 60 * 1000);
}

module.exports = {
  computePriorityScore,
  recomputeAllPriorities,
  generateTasksForClient,
  runGenerationSweep,
  startScheduler
};
