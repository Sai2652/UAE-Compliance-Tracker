// Derivable trends. Buckets by month over the requested window using
// timestamps already stored in our data (no snapshot table needed):
//   filing_completion  ← compliance_obligations.filed_at vs filing_deadline
//   sla_compliance     ← compliance_tasks.completed_date + sla_status
//   escalations        ← compliance_escalation_events.triggered_at
//
// Health / Readiness trends are intentionally NOT provided here — they
// require daily snapshots which we have not enabled.

const repos = require('../../repositories');
const periodHelper = require('./periodHelper');

function defaultWindow(months) {
  const m = months || 12;
  const to = new Date(); to.setUTCDate(1); to.setUTCHours(0, 0, 0, 0);
  // Make `to` the start of next month so the current month is included.
  to.setUTCMonth(to.getUTCMonth() + 1);
  const from = new Date(to.getTime());
  from.setUTCMonth(from.getUTCMonth() - m);
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

async function generate(metric, fromISO, toISO) {
  const win = (fromISO && toISO) ? { fromISO, toISO } : defaultWindow(12);
  const months = periodHelper.enumerateMonths(win.fromISO, win.toISO);

  if (metric === 'health_score' || metric === 'readiness_states') {
    return { available: false, reason: 'Daily snapshots not enabled. Add MIS_SNAPSHOTS_ENABLED=true to capture daily roll-ups.' };
  }

  if (metric === 'filing_completion') {
    const all = await repos.ObligationsRepo.list({ from: win.fromISO.slice(0,10), to: win.toISO.slice(0,10), limit: 10000 });
    const points = months.map(m => {
      const inMonth = all.filter(o => o.filing_deadline >= m.fromISO.slice(0,10) && o.filing_deadline < m.toISO.slice(0,10));
      const filedOnTime = inMonth.filter(o => o.status === 'filed' && o.filed_at && new Date(o.filed_at) <= new Date(o.filing_deadline + 'T23:59:59Z')).length;
      return { period: m.key, due: inMonth.length, filed: inMonth.filter(o => o.status === 'filed').length, filedOnTime, pct: inMonth.length ? Math.round(filedOnTime / inMonth.length * 100) : null };
    });
    return { available: true, metric, points };
  }

  if (metric === 'sla_compliance') {
    const tasks = await repos.TasksRepo.listAll({ limit: 10000 });
    const points = months.map(m => {
      const inMonth = tasks.filter(t => t.completed_date && t.completed_date >= m.fromISO && t.completed_date < m.toISO);
      const cohort = inMonth.filter(t => ['met','breached'].includes(t.sla_status));
      const met = cohort.filter(t => t.sla_status === 'met').length;
      return { period: m.key, completed: inMonth.length, slaCohort: cohort.length, met, pct: cohort.length ? Math.round(met / cohort.length * 100) : null };
    });
    return { available: true, metric, points };
  }

  if (metric === 'escalations') {
    const events = await repos.EscalationEventsRepo.listBetween(win.fromISO, win.toISO);
    const points = months.map(m => {
      const inMonth = events.filter(e => e.triggered_at >= m.fromISO && e.triggered_at < m.toISO);
      const resolved = inMonth.filter(e => e.resolved_at);
      return { period: m.key, triggered: inMonth.length, resolved: resolved.length };
    });
    return { available: true, metric, points };
  }

  return { available: false, reason: 'Unknown metric.' };
}

module.exports = { generate };
