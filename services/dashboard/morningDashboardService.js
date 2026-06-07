// Morning Manager Dashboard — single composite payload for the admin landing
// page. Fans out to existing services in parallel and shapes their outputs
// into 8 ready-to-render sections.
//
// Zero new scoring math. Zero new persistence. The dashboard exists to give
// management 30-second operational visibility by composing what's already
// computed elsewhere.

const repos = require('../../repositories');
const managerActionListSvc = require('../portfolio/managerActionListService');
const clientReadinessService = require('../clientReadinessService');
const capacityService = require('../capacityService');
const riskService = require('../riskService');
const managementSummarySvc = require('../reports/managementSummaryService');
const reviewQueueService = require('../reviewQueueService');
const aiClientInsight = require('../ai/clientInsightService');
const bottleneckAdvisor = require('../ai/bottleneckAdvisorService');
const { getTemplate } = require('../../templates');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d)   { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }
function isoDate(d)   { return new Date(d).toISOString().slice(0, 10); }

// Server-side composite cache (30s) — absorbs double-click refreshes without
// re-running every service. Per-process, in-memory only.
let _cache = null;
const CACHE_MS = 30 * 1000;

async function generate({ force } = {}) {
  if (!force && _cache && (Date.now() - _cache.at) < CACHE_MS) return _cache.payload;

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = isoDate(today);
  const in7   = isoDate(new Date(today.getTime() + 7 * DAY));
  const in14  = isoDate(new Date(today.getTime() + 14 * DAY));
  const thisMonth = todayStr.slice(0, 7);

  const [
    actionList, readinessData, capacity, riskData, mgmtSummary, reviewQueue,
    openTasks, obligations, openEscalations, workflows
  ] = await Promise.all([
    managerActionListSvc.generate(10),
    clientReadinessService.getAllClientReadiness(),
    capacityService.getCapacityDashboard(),
    riskService.runAll(),
    managementSummarySvc.generate(thisMonth).catch(() => null),
    reviewQueueService.getQueue(),
    repos.TasksRepo.listOpen({ limit: 5000 }),
    repos.ObligationsRepo.list({ from: todayStr, to: in14, status: ['upcoming','active','overdue'], limit: 1000 }),
    repos.EscalationEventsRepo.listOpen(),
    repos.WorkflowsRepo.list({ workflowType: ['VAT_Filing','CT_Filing'], status: 'active', limit: 5000 })
  ]);
  const clients = repos.ClientsRepo.listAll();
  const clientScores = riskService.computeClientScores(riskData.findings, riskData.config, clients);

  // -------- Workflow steps — single batched query, shared by sections below.
  const _stepsByWf = await repos.WorkflowStepsRepo.listForWorkflows(workflows.map(w => w.id)).catch(() => ({}));

  // -------- Section 1: Today's Focus (top 10 from manager action list,
  // enriched with a recommended-action sentence per row)
  const todaysFocus = await composeTodaysFocus(actionList.rows || [], openTasks);

  // -------- Section 2: Critical deadlines (uses batched _stepsByWf indirectly via current_step_key)
  const deadlines = composeDeadlines(openTasks, obligations, workflows, todayStr, in7, in14);
  void _stepsByWf;

  // -------- Section 3: Clients Requiring Attention (top 10 — already
  // produced by managerActionListSvc, but we trim+attach next deadline)
  const clientsAttention = composeClientsAttention(actionList.rows || [], openTasks, readinessData);

  // -------- Section 4: Team Health
  const teamHealth = composeTeamHealth(capacity, openTasks, openEscalations);

  // -------- Section 5: Readiness counts (already computed)
  const readinessCounts = readinessData.counts || {};

  // -------- Section 6: Manager Action Center — concrete sentences for the
  // top-10 clients, plus bottleneck recommendations.
  const managerActions = await composeManagerActions(actionList.rows || [], openTasks, readinessData);

  // -------- Section 7: Risk Summary
  const highRiskCount = clientScores.filter(s => s.band === 'amber' || s.band === 'red').length;
  const criticalRiskCount = clientScores.filter(s => s.band === 'red').length;
  const overdueComplianceCount = openTasks.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now()).length;
  const riskSummary = {
    highRiskClients: highRiskCount,
    criticalRiskClients: criticalRiskCount,
    openEscalations: openEscalations.length,
    overdueComplianceItems: overdueComplianceCount
  };

  // -------- Section 8: Business Health Snapshot
  const totalActiveClients = clients.length;
  const readyForFiling = (readinessData.clients || []).filter(r => r.state === 'ready').length;
  const blockedClients = (readinessData.clients || []).filter(r => r.state === 'blocked').length;
  const filingCompletionRate = mgmtSummary ? mgmtSummary.headline.filingCompletionRate : null;
  const slaCompliancePct = computeFirmSlaPct(openTasks);
  const teamUtilizationPct = computeTeamUtilization(capacity);
  const businessHealth = {
    totalActiveClients, readyForFiling, blockedClients,
    filingCompletionRate, slaCompliancePct, teamUtilizationPct
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    todaysFocus, deadlines, clientsAttention, teamHealth,
    readinessCounts, managerActions, riskSummary, businessHealth
  };
  _cache = { at: Date.now(), payload };
  return payload;
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

function composeTeamHealth(capacity, openTasks, openEscalations) {
  const totalOpen = openTasks.length;
  const overdue = openTasks.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now()).length;
  const pendingReviews = openTasks.filter(t => t.status === 'ready_for_review').length;
  const blocked = openTasks.filter(t => t.status === 'blocked' || t.status === 'escalated').length;

  const byUser = (capacity.rows || []).filter(r => r.userId).map(r => ({
    userId: r.userId, userName: r.userName, band: r.band,
    openTasks: r.openTasks, capacity: r.capacity, workloadRatio: r.workloadRatio,
    overdueTasks: r.overdueTasks, awaitingReview: r.awaitingReview, blockedTasks: r.blockedTasks
  }));
  const overloaded = byUser.filter(u => u.band === 'overloaded');
  const capacityRisks = byUser.filter(u => u.band === 'overloaded' || (u.workloadRatio || 0) >= 1.0);

  return {
    totals: {
      totalOpenTasks: totalOpen,
      overdueTasks: overdue,
      pendingReviews,
      blockedWork: blocked,
      openEscalations: openEscalations.length
    },
    byUser, overloaded, capacityRisks
  };
}

async function composeManagerActions(actionListRows, openTasks, readinessData) {
  // For the top 5 clients, derive 1-2 concrete actions from clientInsightService.
  const top = actionListRows.slice(0, 5);
  const actions = [];
  for (const r of top) {
    try {
      const insight = await aiClientInsight.generate(r.clientId);
      if (insight && insight.recommendedActions) {
        insight.recommendedActions.slice(0, 2).forEach(a => actions.push({
          clientId: r.clientId, clientName: r.clientName,
          tier: r.tier, kind: a.kind, sentence: a.sentence,
          taskId: a.taskId || null, docId: a.docId || null
        }));
      }
    } catch (_) { /* skip — don't block dashboard on one client */ }
  }
  // Bottleneck-level recommendations.
  try {
    const bn = await bottleneckAdvisor.generate();
    (bn.bottlenecks || []).slice(0, 3).forEach(b => {
      actions.push({ clientId: null, clientName: null, kind: 'bottleneck:' + b.kind, sentence: b.recommendation });
    });
  } catch (_) { /* skip */ }
  return actions.slice(0, 15);
}

function computeFirmSlaPct(tasks) {
  const cohort = tasks.filter(t => t.status === 'completed' && ['met','breached'].includes(t.sla_status));
  if (!cohort.length) return null;
  const met = cohort.filter(t => t.sla_status === 'met').length;
  return Math.round((met / cohort.length) * 100);
}

function computeTeamUtilization(capacity) {
  const rows = (capacity.rows || []).filter(r => r.userId && r.capacity);
  if (!rows.length) return null;
  const totalCap = rows.reduce((s, r) => s + r.capacity, 0);
  const totalOpen = rows.reduce((s, r) => s + r.openTasks, 0);
  return Math.round((totalOpen / totalCap) * 100);
}

module.exports = { generate };
