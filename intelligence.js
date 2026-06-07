// UAE Compliance Intelligence — pure date math.
//
// References (UAE FTA, as of writing):
//   • VAT return: filed within 28 days after end of tax period.
//       - Frequency: Monthly or Quarterly. Quarter alignment is per the
//         taxpayer's allocated stagger (Mar/Jun/Sep/Dec OR Jan/Apr/Jul/Oct OR
//         Feb/May/Aug/Nov). We anchor quarters to the registration date.
//   • Corporate Tax return: filed within 9 months after end of relevant
//     tax period.
//       - First tax period for a newly-incorporated entity may extend up to
//         18 months (Art. 57 Cabinet Decision No. 74 of 2023 / UAE CT Law).
//
// Everything here is pure: no DB, no I/O. Inputs/outputs are ISO date strings
// or `Date`. All date math is done in UTC to keep things deterministic.

const DAY = 24 * 60 * 60 * 1000;

function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
}
function iso(d) { return d ? new Date(d).toISOString().slice(0,10) : null; }
function addDays(d, n) { return new Date(new Date(d).getTime() + n * DAY); }
function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  // clamp day to month length
  const dim = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, dim));
  return x;
}
function endOfMonth(year, monthIdx0) { return new Date(Date.UTC(year, monthIdx0 + 1, 0)); }

// ---------- VAT ----------
//
// VAT period math anchored on registration date.
// frequency: 'Monthly' | 'Quarterly' (default Quarterly).
// Returns periods whose filing_deadline falls in [from, to].
function vatPeriodsBetween(registrationDate, frequency, from, to) {
  const reg = toDate(registrationDate);
  if (!reg) return [];
  const fromD = toDate(from) || new Date();
  const toD = toDate(to) || addMonths(fromD, 12);
  const monthsPerPeriod = (frequency || 'Quarterly') === 'Monthly' ? 1 : 3;

  const periods = [];
  // First period starts at the registration month start; we then step forward.
  let pStart = new Date(Date.UTC(reg.getUTCFullYear(), reg.getUTCMonth(), 1));
  // Advance pStart forward until period_end >= fromD - 90d (so we don't miss
  // an in-window deadline).
  while (true) {
    const pEnd = new Date(addMonths(pStart, monthsPerPeriod).getTime() - DAY);
    const filingDeadline = new Date(addDays(pEnd, 28));
    if (filingDeadline > toD) break;
    if (filingDeadline >= addDays(fromD, -1)) {
      periods.push({
        type: 'VAT_Return',
        period_start: iso(pStart),
        period_end: iso(pEnd),
        filing_deadline: iso(filingDeadline),
        payment_deadline: iso(filingDeadline),
        period_label: vatPeriodLabel(pStart, monthsPerPeriod)
      });
    }
    pStart = addMonths(pStart, monthsPerPeriod);
    if (periods.length > 24) break; // safety
  }
  return periods;
}

function vatPeriodLabel(periodStart, monthsPerPeriod) {
  const y = periodStart.getUTCFullYear();
  const m = periodStart.getUTCMonth();
  if (monthsPerPeriod === 1) return `${y}-${String(m + 1).padStart(2, '0')}`;
  // Quarterly: label by anchor quarter
  const q = Math.floor(m / 3) + 1;
  return `${y}-Q${q}`;
}

// ---------- Corporate Tax ----------
//
// Inputs:
//   incorporationDate: ISO date string (optional — needed for first-period 18m rule)
//   fyEnd:              'MM-DD' string (e.g. '12-31'); default '12-31'
//   from / to:          window for which to emit obligations
//
// Output: list of CT tax periods with filing_deadline = period_end + 9 months.
// For a new entity (incorporationDate provided), the first period may be up to
// 18 months: we choose the next fyEnd that is >= incorporation + 6 months and
// <= incorporation + 18 months. After the first period, normal 12-month cycles.
function ctPeriodsBetween(incorporationDate, fyEnd, from, to) {
  const fyMMDD = (fyEnd || '12-31').split('-').map(n => parseInt(n, 10));
  const fyMonth0 = (fyMMDD[0] || 12) - 1;
  const fyDay = fyMMDD[1] || 31;
  const inc = toDate(incorporationDate);
  const fromD = toDate(from) || new Date();
  const toD = toDate(to) || addMonths(fromD, 24);

  const periods = [];
  let pStart, pEnd;

  if (inc) {
    pStart = new Date(Date.UTC(inc.getUTCFullYear(), inc.getUTCMonth(), inc.getUTCDate()));
    // Pick first FY end >= inc + ~6 months that gives a period <= 18 months.
    // Strategy: walk candidate FY ends forward from inc until one is at
    // least 6 months and at most 18 months from inc.
    let candYear = inc.getUTCFullYear();
    let candidate = null;
    for (let i = 0; i < 3; i++) {
      const c = new Date(Date.UTC(candYear + i, fyMonth0, fyDay));
      const months = (c.getUTCFullYear() - inc.getUTCFullYear()) * 12 + (c.getUTCMonth() - inc.getUTCMonth());
      if (months >= 6 && months <= 18 && c > inc) { candidate = c; break; }
    }
    // If still null (fyEnd very close to incorporation), bump one full year.
    if (!candidate) {
      candidate = new Date(Date.UTC(inc.getUTCFullYear() + 1, fyMonth0, fyDay));
    }
    pEnd = candidate;
  } else {
    // No incorporation date — anchor to current FY containing `fromD`.
    const y = fromD.getUTCFullYear();
    const fyEndThisYear = new Date(Date.UTC(y, fyMonth0, fyDay));
    pEnd = (fromD <= fyEndThisYear) ? fyEndThisYear : new Date(Date.UTC(y + 1, fyMonth0, fyDay));
    pStart = new Date(addDays(addMonths(pEnd, -12), 1));
  }

  // Emit successive 12-month periods until filing deadline > toD.
  let count = 0;
  while (count < 10) {
    const filingDeadline = addMonths(pEnd, 9);
    if (filingDeadline > toD && periods.length > 0) break;
    if (filingDeadline >= addDays(fromD, -1)) {
      periods.push({
        type: 'CT_Return',
        period_start: iso(pStart),
        period_end: iso(pEnd),
        filing_deadline: iso(filingDeadline),
        payment_deadline: iso(filingDeadline),
        period_label: ctPeriodLabel(pStart, pEnd),
        metadata: { first_period: count === 0 && !!inc, length_months: monthsBetween(pStart, pEnd) }
      });
    }
    // Next period: start = old end + 1 day, end = +12 months
    pStart = addDays(pEnd, 1);
    pEnd = new Date(addDays(addMonths(pStart, 12), -1));
    count++;
    if (filingDeadline > toD) break;
  }
  return periods;
}

function ctPeriodLabel(pStart, pEnd) {
  const sy = pStart.getUTCFullYear();
  const ey = pEnd.getUTCFullYear();
  if (sy === ey) return `FY${ey}`;
  return `FY${sy}-${String(ey).slice(2)}`;
}

function monthsBetween(a, b) {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

// ---------- Reminder / Escalation schedules ----------
function reminderSchedule(deadline) {
  const d = toDate(deadline); if (!d) return [];
  return [-30, -14, -7, -3, -1].map(n => ({ at: iso(addDays(d, n)), kind: 'reminder', offset_days: n }));
}
function escalationSchedule(deadline) {
  const d = toDate(deadline); if (!d) return [];
  return [-3, 0, 3, 7, 14].map(n => ({ at: iso(addDays(d, n)), kind: 'escalation', offset_days: n }));
}

module.exports = {
  vatPeriodsBetween, ctPeriodsBetween,
  reminderSchedule, escalationSchedule,
  // exported helpers for tests / engine
  _iso: iso, _addDays: addDays, _addMonths: addMonths
};
