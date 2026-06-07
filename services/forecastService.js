// Forecasting — bucket upcoming tasks + obligations by day, compare to capacity.
const repos = require('../repositories');

const DAY = 24 * 60 * 60 * 1000;
function isoDate(d) { return new Date(d).toISOString().slice(0,10); }

async function getForecast(days) {
  const horizon = Math.max(1, Math.min(60, parseInt(days, 10) || 30));
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const from = isoDate(today);
  const to = isoDate(new Date(today.getTime() + horizon * DAY));

  const [tasks, obligations, users, config] = await Promise.all([
    repos.TasksRepo.listOpen({ dueBefore: to, limit: 5000 }),
    repos.ObligationsRepo.listBetween(from, to),
    Promise.resolve(repos.UsersRepo.listActive()),
    repos.WorkloadConfigRepo.getAll()
  ]);

  // Bucket per day
  const buckets = {};
  for (let i = 0; i < horizon; i++) {
    const d = isoDate(new Date(today.getTime() + i * DAY));
    buckets[d] = { date: d, taskCount: 0, obligationCount: 0 };
  }
  tasks.forEach(t => { if (t.due_date && buckets[t.due_date]) buckets[t.due_date].taskCount++; });
  obligations.forEach(o => { if (o.filing_deadline && buckets[o.filing_deadline]) buckets[o.filing_deadline].obligationCount++; });

  // Capacity per day: active_users * (capacity_open_tasks / 7)
  const dailyCapacity = users.length * (config.default_capacity_open_tasks / 7);

  const arr = Object.values(buckets);
  // Rolling median for spike detection
  const sorted = arr.map(b => b.taskCount + b.obligationCount).slice().sort((a,b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  arr.forEach(b => {
    const load = b.taskCount + b.obligationCount;
    b.load = load;
    b.capacity = Math.round(dailyCapacity * 10) / 10;
    if (load > Math.max(2 * median, dailyCapacity * 1.5)) b.flag = 'spike';
    else if (load > dailyCapacity * 1.1) b.flag = 'over_capacity';
    else b.flag = 'ok';
  });

  // Warnings
  const warnings = [];
  const week = arr.slice(0, 7);
  const weekLoad = week.reduce((s, b) => s + b.load, 0);
  const weekCap = dailyCapacity * 7;
  if (weekCap > 0 && weekLoad > weekCap * 1.1) {
    const pct = Math.round(((weekLoad - weekCap) / weekCap) * 100);
    warnings.push({ kind: 'capacity_shortfall_week', message: `Expected workload exceeds team capacity by ${pct}% next week (${weekLoad} items vs ${Math.round(weekCap)} capacity).`, severity: pct >= 25 ? 'high' : 'medium' });
  }
  const monthLoad = arr.reduce((s, b) => s + b.load, 0);
  const monthCap = dailyCapacity * horizon;
  if (monthCap > 0 && monthLoad > monthCap * 1.1) {
    const pct = Math.round(((monthLoad - monthCap) / monthCap) * 100);
    warnings.push({ kind: 'capacity_shortfall_horizon', message: `Workload over next ${horizon} days exceeds capacity by ${pct}%.`, severity: pct >= 25 ? 'high' : 'medium' });
  }
  arr.filter(b => b.flag === 'spike').forEach(b => {
    warnings.push({ kind: 'spike', message: `Spike on ${b.date}: ${b.load} items due.`, severity: 'medium', date: b.date });
  });

  return {
    horizonDays: horizon,
    from, to,
    activeUsers: users.length,
    dailyCapacity: Math.round(dailyCapacity * 10) / 10,
    buckets: arr,
    next7d: week.reduce((s, b) => s + b.load, 0),
    next30d: arr.reduce((s, b) => s + b.load, 0),
    warnings
  };
}

module.exports = { getForecast };
