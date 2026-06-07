// Calendar-aligned period helper for MIS reports.
// Supports: month=YYYY-MM, quarter=YYYY-Qn, year=YYYY. Defaults to current month.
// All bounds returned as ISO date-time strings (UTC).

function pad(n) { return String(n).padStart(2, '0'); }

function currentMonth() { const d = new Date(); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); }
function currentQuarter() { const d = new Date(); return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1); }
function currentYear() { return String(new Date().getUTCFullYear()); }

function resolveBounds(period, value) {
  let from, to, label, normalized;
  if (period === 'year') {
    const y = parseInt(value || currentYear(), 10);
    from = new Date(Date.UTC(y, 0, 1));
    to   = new Date(Date.UTC(y + 1, 0, 1));
    label = String(y);
    normalized = String(y);
  } else if (period === 'quarter') {
    const v = value || currentQuarter();
    const m = /^(\d{4})-Q([1-4])$/.exec(v);
    if (!m) throw new Error('quarter must be YYYY-Qn');
    const y = parseInt(m[1], 10), q = parseInt(m[2], 10);
    from = new Date(Date.UTC(y, (q - 1) * 3, 1));
    to   = new Date(Date.UTC(y, q * 3, 1));
    label = `${y} Q${q}`;
    normalized = v;
  } else {
    // month
    const v = value || currentMonth();
    const m = /^(\d{4})-(\d{2})$/.exec(v);
    if (!m) throw new Error('month must be YYYY-MM');
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    from = new Date(Date.UTC(y, mo - 1, 1));
    to   = new Date(Date.UTC(y, mo, 1));
    label = `${y}-${pad(mo)}`;
    normalized = v;
  }
  return {
    period: period || 'month',
    value: normalized,
    label,
    fromISO: from.toISOString(),
    toISO: to.toISOString(),
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10)
  };
}

// Previous period (for trend deltas)
function previous(bounds) {
  const fromMs = new Date(bounds.fromISO).getTime();
  const toMs   = new Date(bounds.toISO).getTime();
  const span = toMs - fromMs;
  return {
    fromISO: new Date(fromMs - span).toISOString(),
    toISO: new Date(fromMs).toISOString()
  };
}

// Enumerate months within a date window for trend bucketing.
function enumerateMonths(fromISO, toISO) {
  const a = new Date(fromISO); const b = new Date(toISO);
  const out = [];
  let y = a.getUTCFullYear(), m = a.getUTCMonth();
  while (true) {
    const lo = new Date(Date.UTC(y, m, 1));
    if (lo >= b) break;
    out.push({ key: `${y}-${pad(m + 1)}`, fromISO: lo.toISOString(), toISO: new Date(Date.UTC(y, m + 1, 1)).toISOString() });
    m++; if (m > 11) { m = 0; y++; }
    if (out.length > 60) break; // safety
  }
  return out;
}

function options() {
  // 12 trailing months, 4 trailing quarters, 3 trailing years for dropdowns.
  const now = new Date();
  const months = [], quarters = [], years = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1));
  }
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i * 3, 1));
    quarters.push(d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1));
  }
  for (let i = 0; i < 3; i++) years.push(String(now.getUTCFullYear() - i));
  return { months, quarters, years, current: { month: currentMonth(), quarter: currentQuarter(), year: currentYear() } };
}

module.exports = { resolveBounds, previous, enumerateMonths, options, currentMonth, currentQuarter, currentYear };
