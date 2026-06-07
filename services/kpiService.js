// Team KPI Dashboard — firm-wide numbers with trend deltas vs previous period.
const repos = require('../repositories');
const DAY = 24 * 60 * 60 * 1000;
const RANGES = { '7': 7, '30': 30, '90': 90 };

function bounds(range) {
  const days = RANGES[String(range)] || 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);
  const prevFrom = new Date(from.getTime() - days * DAY);
  return {
    days,
    currentFrom: from.toISOString(), currentTo: now.toISOString(),
    previousFrom: prevFrom.toISOString(), previousTo: from.toISOString()
  };
}

function computeWindow(tasks, escalations, fromISO, toISO) {
  const completed = tasks.filter(t => t.completed_date && t.completed_date >= fromISO && t.completed_date <= toISO);
  const open = tasks.filter(t => t.status !== 'completed');
  const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now());

  const cohort = completed.filter(t => ['met','breached'].includes(t.sla_status));
  const slaPct = cohort.length ? Math.round((cohort.filter(t => t.sla_status === 'met').length / cohort.length) * 100) : null;

  const dur = completed.filter(t => t.created_date).map(t => (new Date(t.completed_date) - new Date(t.created_date)) / DAY);
  const avgDuration = dur.length ? Math.round((dur.reduce((a,b)=>a+b,0) / dur.length) * 10) / 10 : null;

  const escCount = escalations.filter(e => e.triggered_at >= fromISO && e.triggered_at <= toISO).length;
  const overduePct = open.length ? Math.round((overdue.length / open.length) * 100) : 0;

  return {
    tasksCompleted: completed.length,
    slaCompliancePct: slaPct,
    avgTaskDurationDays: avgDuration,
    escalationsTriggered: escCount,
    overdueWorkPct: overduePct,
    openTasks: open.length
  };
}

function delta(curr, prev) {
  if (curr == null || prev == null) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return Math.round(((curr - prev) / prev) * 100);
}

async function getKpis(range) {
  const b = bounds(range);
  const [tasks, escCurrent, escPrev] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.EscalationEventsRepo.listBetween(b.currentFrom, b.currentTo),
    repos.EscalationEventsRepo.listBetween(b.previousFrom, b.previousTo)
  ]);
  const current = computeWindow(tasks, escCurrent, b.currentFrom, b.currentTo);
  const previous = computeWindow(tasks, escPrev, b.previousFrom, b.previousTo);

  // Special-case "this week" / "this month" headline numbers
  const startWeek = new Date(); startWeek.setUTCDate(startWeek.getUTCDate() - startWeek.getUTCDay()); startWeek.setUTCHours(0,0,0,0);
  const startMonth = new Date(); startMonth.setUTCDate(1); startMonth.setUTCHours(0,0,0,0);
  const completedThisWeek = tasks.filter(t => t.completed_date && new Date(t.completed_date) >= startWeek).length;
  const completedThisMonth = tasks.filter(t => t.completed_date && new Date(t.completed_date) >= startMonth).length;

  return {
    range: b.days,
    headline: { completedThisWeek, completedThisMonth },
    current,
    previous,
    trend: {
      tasksCompleted: delta(current.tasksCompleted, previous.tasksCompleted),
      slaCompliancePct: delta(current.slaCompliancePct, previous.slaCompliancePct),
      avgTaskDurationDays: delta(current.avgTaskDurationDays, previous.avgTaskDurationDays),
      escalationsTriggered: delta(current.escalationsTriggered, previous.escalationsTriggered),
      overdueWorkPct: delta(current.overdueWorkPct, previous.overdueWorkPct)
    }
  };
}

module.exports = { getKpis };
