// Today dashboard — single composite payload for the landing page.
//
// Three sections, matching what the Today redesign actually renders:
//   todaysFocus       — top-10 action rows with a recommended sentence
//   deadlines         — overdue / today / next-7 / next-14 buckets
//   clientsAttention  — the attention list the page is built around
//
// It used to build eight. The other five were computed in full on every
// request and discarded by the browser; removing them (and the services
// that only fed them) is what took this endpoint from minutes to
// seconds. See the comment above the Promise.all below.

const repos = require('../../repositories');
const managerActionListSvc = require('../portfolio/managerActionListService');
const clientReadinessService = require('../clientReadinessService');
const { getTemplate } = require('../../templates');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function isoDate(d)   { return new Date(d).toISOString().slice(0, 10); }

// Server-side composite cache (30s) — absorbs double-click refreshes without
// re-running every service. Per-process, in-memory only. Keyed by caller
// visibility scope: a Super Admin's cached payload is not served to an
// Admin, because they see different subsets. Cache key is a stable
// signature of the visibleClientIds set (or 'ALL' for full-visibility).
const _cache = new Map();  // key -> {at, payload}
const CACHE_MS = 30 * 1000;

async function generate({ force, user, allUsers } = {}) {
  // Visibility scoping — the previous version ignored `user` entirely and
  // returned the whole firm's payload to every caller, so Admins saw every
  // client's tasks, escalations and deadlines on their Today tab. We now
  // require callers to pass user + allUsers so we can resolve their client
  // scope (Prime/Super = everyone; Admin = own name + downline; User =
  // own name only) and filter the payload before returning.
  const roles = require('../../roles');
  let scope = { all: true, names: null };
  if (user) scope = roles.clientScope(user, allUsers || []);

  const cacheKey = scope.all ? 'ALL' : Array.from(scope.names || []).sort().join('|') || '__none__';
  const hit = _cache.get(cacheKey);
  if (!force && hit && (Date.now() - hit.at) < CACHE_MS) return hit.payload;

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = isoDate(today);
  const in7   = isoDate(new Date(today.getTime() + 7 * DAY));
  const in14  = isoDate(new Date(today.getTime() + 14 * DAY));

  // Only fetch what the three rendered sections actually need.
  //
  // This endpoint used to take minutes. It was computing eight sections,
  // but the Today redesign left only three of them on screen —
  // todaysFocus, deadlines and clientsAttention. The other five
  // (managerActions, teamHealth, readinessCounts, riskSummary,
  // businessHealth) were computed in full and thrown away by the
  // browser. managerActions was the worst: five SEQUENTIAL
  // aiClientInsight.generate() round trips plus a bottleneck scan, for
  // a panel that no longer exists.
  //
  // Dropped with them: capacityService.getCapacityDashboard(),
  // riskService.runAll(), managementSummarySvc.generate(),
  // reviewQueueService.getQueue() and EscalationEventsRepo.listOpen() —
  // every one of those was feeding only a discarded section.
  let [
    actionList, readinessData, openTasks, obligations, workflows
  ] = await Promise.all([
    managerActionListSvc.generate(10),
    clientReadinessService.getAllClientReadiness(),
    repos.TasksRepo.listOpen({ limit: 5000 }),
    repos.ObligationsRepo.list({ from: todayStr, to: in14, status: ['upcoming','active','overdue'], limit: 1000 }),
    repos.WorkflowsRepo.list({ workflowType: ['VAT_Filing','CT_Filing'], status: 'active', limit: 5000 })
  ]);
  const allClients = repos.ClientsRepo.listAll();

  // Filter every downstream data source through the caller's scope. Anything
  // that carries a client id (task, obligation, escalation, workflow, action
  // row, readiness row) drops out if the client isn't in the caller's book.
  // For unscoped callers (Prime/Super) `scope.all` is true and inclusion
  // becomes a no-op.
  const includeById   = (cid) => scope.all ? true : !!(scope.names && (function(){
    // Match by client's assignedTeam name — that's how visibility resolves elsewhere.
    var cli = allClients.find(function(c){ return String(c.id) === String(cid); });
    return cli && scope.names.has(cli.assignedTeam);
  })());
  const includeByName = (nm)  => scope.all ? true : !!(scope.names && nm && scope.names.has(nm));

  const clients = scope.all ? allClients : allClients.filter(c => c.assignedTeam && scope.names.has(c.assignedTeam));
  const scopedOpenTasks       = scope.all ? openTasks       : openTasks.filter(t => includeByName(t.assigned_user_name) || includeById(t.client_external_id));
  const scopedObligations     = scope.all ? obligations     : obligations.filter(o => includeById(o.client_external_id));
  const scopedWorkflows       = scope.all ? workflows       : workflows.filter(w => includeById(w.client_external_id));
  const scopedActionRows      = scope.all ? (actionList.rows || []) : (actionList.rows || []).filter(r => includeById(r.clientId));
  const scopedReadinessClients= scope.all ? (readinessData.clients || []) : (readinessData.clients || []).filter(r => includeById(r.clientId));
  const scopedReadinessData   = { ...readinessData, clients: scopedReadinessClients, counts: scope.all ? readinessData.counts : recount(scopedReadinessClients) };
  // Aliases — rest of the function reads these names.
  openTasks       = scopedOpenTasks;
  obligations     = scopedObligations;
  workflows       = scopedWorkflows;
  actionList      = { ...actionList, rows: scopedActionRows };
  readinessData   = scopedReadinessData;

  // -------- Section 1: Today's Focus (top 10 from manager action list,
  // enriched with a recommended-action sentence per row)
  const todaysFocus = await composeTodaysFocus(actionList.rows || [], openTasks);

  // -------- Section 2: Critical deadlines
  const deadlines = composeDeadlines(openTasks, obligations, workflows, todayStr, in7, in14);

  // -------- Section 3: Clients Requiring Attention (top 10 — already
  // produced by managerActionListSvc, but we trim+attach next deadline)
  const clientsAttention = composeClientsAttention(actionList.rows || [], openTasks, readinessData);

  // The four retired sections keep their keys with empty values rather
  // than disappearing, so an older cached page that still reads
  // d.teamHealth.totals gets an object instead of a TypeError.
  const payload = {
    generatedAt: new Date().toISOString(),
    todaysFocus, deadlines, clientsAttention,
    clientCount: clients.length,
    teamHealth: { totals: {}, byUser: [], overloaded: [], capacityRisks: [] },
    readinessCounts: readinessData.counts || {},
    managerActions: [],
    riskSummary: {},
    businessHealth: { totalActiveClients: clients.length }
  };
  _cache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}

// Roll a scoped readiness-clients slice back into count buckets so
// downstream renders (Filing Readiness chips, if any) still add up.
function recount(rows){
  const c = {};
  (rows || []).forEach(r => { if(r && r.state) c[r.state] = (c[r.state] || 0) + 1; });
  return c;
}

// ---------- Section builders ----------

async function composeTodaysFocus(actionListRows, openTasks) {
  const tasksByClient = {};
  openTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });

  const items = actionListRows.slice(0, 10).map(row => {
    const cid = String(row.clientId);
    const list = (tasksByClient[cid] || []).filter(t => t.due_date)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const nextTask = list[0] || null;
    // Derive the most actionable single-line issue + recommended action.
    let issue, recommended;
    if (row.openEscalations > 0)             { issue = `${row.openEscalations} open escalation(s)`; recommended = 'Review escalations and reassign or escalate to admin.'; }
    else if (row.documentsPending > 0)       { issue = `${row.documentsPending} document(s) pending`; recommended = 'Escalate the oldest document request to the client.'; }
    else if (row.upcomingDeadlines > 0)      { issue = `${row.upcomingDeadlines} deadline(s) within 7 days`; recommended = 'Confirm assigned user is actively working on the filing.'; }
    else if (row.responsivenessScore != null && row.responsivenessScore < 50) { issue = `Low responsiveness (score ${row.responsivenessScore})`; recommended = 'Call the client to clear blockers.'; }
    else if (row.riskBand === 'critical' || row.riskBand === 'high') { issue = `${row.riskBand} risk`; recommended = 'Drill into client insight panel and act on the top risks.'; }
    else { issue = 'Action score ' + row.score; recommended = (row.reasons && row.reasons[0]) || 'Review client status.'; }

    return {
      clientId: row.clientId, clientName: row.clientName,
      tier: row.tier, riskBand: row.riskBand, score: row.score,
      issue,
      dueDate: nextTask ? nextTask.due_date : null,
      assignedUser: nextTask ? nextTask.assigned_user_name : row.owner,
      taskId: nextTask ? nextTask.id : null,
      recommendedAction: recommended
    };
  });
  return { items };
}

function composeDeadlines(openTasks, obligations, workflows, todayStr, in7, in14) {
  const dueToday  = openTasks.filter(t => t.due_date === todayStr);
  const next7     = openTasks.filter(t => t.due_date && t.due_date > todayStr && t.due_date <= in7);
  const next14    = openTasks.filter(t => t.due_date && t.due_date > in7 && t.due_date <= in14);
  const overdue   = openTasks.filter(t => t.due_date && t.due_date < todayStr);

  // Group by compliance category
  const categorize = t => {
    if (!t || !t.task_type) return 'Other';
    if (t.task_type.startsWith('VAT')) return 'VAT';
    if (t.task_type.startsWith('CT'))  return 'CT';
    if (/Registration/.test(t.task_type)) return 'Registration';
    if (t.task_type === 'Review' || t.status === 'ready_for_review') return 'Review';
    return 'Other';
  };
  // Client Approval bucket comes from workflows at Client_Confirmation step.
  const clientApproval = [];
  workflows.forEach(wf => {
    const tmpl = getTemplate(wf.workflow_type);
    if (!tmpl) return;
    if (wf.current_step_key === tmpl.confirmationStepKey) {
      const linked = openTasks.find(t => t.id === wf.task_id);
      if (linked && linked.due_date) clientApproval.push(linked);
    }
  });

  const groupRows = rows => {
    const groups = { VAT: [], CT: [], Registration: [], Review: [], 'Client Approval': [], Other: [] };
    rows.forEach(t => { groups[categorize(t)].push(toDeadlineRow(t)); });
    clientApproval.forEach(t => { if (rows.indexOf(t) >= 0) groups['Client Approval'].push(toDeadlineRow(t)); });
    return groups;
  };

  return {
    todayCount: dueToday.length,
    next7Count: next7.length,
    next14Count: next14.length,
    overdueCount: overdue.length,
    today: dueToday.slice(0, 25).map(toDeadlineRow),
    next7: next7.slice(0, 25).map(toDeadlineRow),
    next14: next14.slice(0, 25).map(toDeadlineRow),
    overdue: overdue.slice(0, 25).map(toDeadlineRow),
    byCategory: groupRows([...dueToday, ...next7, ...next14]) // upcoming only, by category
  };
}

function toDeadlineRow(t) {
  return {
    taskId: t.id, clientId: t.client_external_id, clientName: t.client_name,
    taskType: t.task_type, status: t.status,
    dueDate: t.due_date, daysToDue: daysUntil(t.due_date),
    assignedUser: t.assigned_user_name
  };
}

function composeClientsAttention(actionListRows, openTasks, readinessData) {
  const tasksByClient = {};
  openTasks.forEach(t => { (tasksByClient[t.client_external_id] = tasksByClient[t.client_external_id] || []).push(t); });
  const readinessByClient = {}; (readinessData.clients || []).forEach(r => { readinessByClient[String(r.clientId)] = r; });
  return actionListRows.slice(0, 10).map(row => {
    const cid = String(row.clientId);
    const next = (tasksByClient[cid] || []).filter(t => t.due_date)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))[0] || null;
    const readiness = readinessByClient[cid] || { state: 'idle' };
    let recommended = (row.reasons && row.reasons[0]) || null;
    if (row.openEscalations > 0)        recommended = 'Resolve open escalation';
    else if (row.documentsPending > 0)  recommended = `Escalate ${row.documentsPending} doc request(s)`;
    else if (row.upcomingDeadlines > 0) recommended = 'Track filing progress';
    return {
      clientId: row.clientId, clientName: row.clientName,
      tier: row.tier, riskBand: row.riskBand,
      readinessState: readiness.state,
      nextDeadline: next ? next.due_date : null,
      nextDeadlineType: next ? next.task_type : null,
      recommendedAction: recommended
    };
  });
}


module.exports = { generate };
