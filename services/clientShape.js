// Client shape adapter — the boundary between the UI's client record and the
// compliance engines.
//
// The UI is the source of truth and writes a NESTED record:
//
//   {
//     vatApplicable: 'Yes' | 'No' | 'Pending...',
//     vat: { returnDates: [ { period, dueDate, fy, filingStatus, paymentStatus } ] },
//     ctApplicable: true,
//     ct:  { financialYear: '2025', dueDate: '2026-09-30', status, ... },
//     accounting: { financialYear, monthlyStatus: { 'YYYY-MM': status } }
//   }
//
// The obligation engine was written against a FLAT record — client.vatRegistrationDate,
// client.ctRegistrationDate, client.financialYearEnd — that no client has ever
// had. Measured against the live blob: 0 of 39 clients hold any of those fields,
// which is why the daily sweep produced nothing for seven weeks.
//
// We translate here rather than reshaping 39 live client records, because the
// UI's shape is the one the team actually maintains.
//
// Everything in this module is pure: no I/O, no DB. Inputs and outputs are ISO
// date strings. All arithmetic is UTC.

const DAY = 24 * 60 * 60 * 1000;

// VAT return is due 28 days after the end of the tax period (FTA).
const VAT_FILING_LAG_DAYS = 28;
// CT return is due 9 months after the end of the tax period (UAE CT Law).
const CT_FILING_LAG_MONTHS = 9;
// Don't run away if a client's dates are nonsense.
const MAX_PERIODS = 8;

function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d) ? null : d;
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
}
function iso(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }
function addDays(d, n) { return new Date(new Date(d).getTime() + n * DAY); }
function lastDayOfMonth(year, month0) { return new Date(Date.UTC(year, month0 + 1, 0)); }
function isMonthEnd(d) {
  return d.getUTCDate() === lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth()).getUTCDate();
}

// Month arithmetic that keeps a month-end date on the month end.
//
// This matters and plain day-clamping gets it wrong. UAE deadlines are written
// as "N months after the period end", and period ends are nearly always month
// ends: 31 Dec + 9 months must be 30 Sep. Clamping gets that right by accident,
// but the inverse — recovering 31 Dec from 30 Sep — lands on 30 Dec and silently
// shifts the whole tax period by a day.
function shiftMonths(d, n) {
  const x = toDate(d);
  if (!x) return null;
  const y = x.getUTCFullYear(), m = x.getUTCMonth();
  if (isMonthEnd(x)) return lastDayOfMonth(y, m + n);
  const target = new Date(Date.UTC(y, m + n, 1));
  const dim = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(x.getUTCDate(), dim)));
}

function isApplicable(v) {
  return v === true || v === 'Yes' || v === 'yes';
}

// A period label that reads the way an accountant would say it.
function fyLabel(periodStart, periodEnd) {
  const sy = periodStart.getUTCFullYear(), ey = periodEnd.getUTCFullYear();
  return sy === ey ? `FY${ey}` : `FY${sy}-${String(ey).slice(2)}`;
}

// ---------------------------------------------------------------- Corporate Tax

// The team captures ct.dueDate — the filing deadline — and that single value
// implies the period end exactly (deadline minus 9 months). It also carries the
// client's real year-end, which is captured nowhere else: ct.financialYear is
// only a year ('2025'), with no month or day.
function ctPeriodEndFrom(ct) {
  if (ct.dueDate) {
    const due = toDate(ct.dueDate);
    if (due) return shiftMonths(due, -CT_FILING_LAG_MONTHS);
  }
  // No deadline entered — fall back to a December year-end on the stated FY.
  const fy = parseInt(String(ct.financialYear || ''), 10);
  if (fy >= 2000 && fy <= 2100) return new Date(Date.UTC(fy, 11, 31));
  return null;
}

function ctObligations(client, opts) {
  opts = opts || {};
  if (!client || !isApplicable(client.ctApplicable)) return [];
  const ct = client.ct || {};
  let periodEnd = ctPeriodEndFrom(ct);
  if (!periodEnd) return [];

  const horizon = addDays(opts.today || new Date(), (opts.forwardMonths || 12) * 30);
  const out = [];
  for (let i = 0; i < MAX_PERIODS; i++) {
    const deadline = shiftMonths(periodEnd, CT_FILING_LAG_MONTHS);
    // Always emit the period the team has actually recorded, even if its
    // deadline has passed — an overdue return is still an obligation. Later
    // periods only count if they fall inside the planning horizon.
    if (i > 0 && deadline > horizon) break;
    const periodStart = addDays(shiftMonths(periodEnd, -12), 1);
    out.push({
      obligationType: 'CT_Return',
      periodLabel: fyLabel(periodStart, periodEnd),
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      filingDeadline: iso(deadline),
      paymentDeadline: iso(deadline),
      status: String(ct.status || '') === 'Completed' ? 'filed' : 'pending',
      metadata: {
        derivedFrom: ct.dueDate ? 'ct.dueDate' : 'ct.financialYear',
        statedFinancialYear: ct.financialYear || null
      }
    });
    periodEnd = shiftMonths(periodEnd, 12);
  }
  return out;
}

// ------------------------------------------------------------------------- VAT

// Frequency isn't captured as a field. Infer it from the spacing of the return
// dates the team entered, which is more reliable than assuming quarterly.
function vatMonthsPerPeriod(vat, rows) {
  const f = String(vat.frequency || '').toLowerCase();
  if (f.startsWith('month')) return 1;
  if (f.startsWith('quarter')) return 3;
  const ds = rows.map(r => toDate(r.dueDate)).filter(Boolean).sort((a, b) => a - b);
  if (ds.length >= 2) {
    const gaps = [];
    for (let i = 1; i < ds.length; i++) gaps.push(Math.round((ds[i] - ds[i - 1]) / DAY));
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median <= 45) return 1;
    if (median <= 135) return 3;
    return Math.max(1, Math.min(12, Math.round(median / 30)));
  }
  return 3;
}

// Recover the tax period end from a stored VAT due date.
//
// Do NOT do this by subtracting 28 days. The UI generates due dates as the 28th
// of the month following the period end and then pushes them to the next UAE
// business day (app.html nextBusinessDay), so a stored due date can sit on the
// 29th, 30th, 1st or 2nd. Subtracting 28 from those lands mid-month and shifts
// the whole period — measured against generated data, roughly a third of rows.
//
// The 28th is the real anchor, so recover it: it's the latest 28th at or before
// the stored due date. The period then ends on the last day of the month before.
function vatPeriodEndFromDue(due) {
  const d = toDate(due);
  if (!d) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  let anchor = new Date(Date.UTC(y, m, 28));
  if (anchor > d) anchor = new Date(Date.UTC(y, m - 1, 28));
  return lastDayOfMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1);
}

function vatObligations(client, opts) {
  opts = opts || {};
  if (!client || !isApplicable(client.vatApplicable)) return [];
  const vat = client.vat || {};
  const rows = (Array.isArray(vat.returnDates) ? vat.returnDates : []).filter(r => r && r.dueDate);
  if (!rows.length) return [];

  const months = vatMonthsPerPeriod(vat, rows);
  const out = [];
  for (const r of rows) {
    const due = toDate(r.dueDate);
    if (!due) continue;
    // Rows written by the certificate reader carry the exact period. Older rows
    // and hand-entered ones don't, so fall back to recovering it from the due date.
    const periodEnd = toDate(r.periodEnd) || vatPeriodEndFromDue(due);
    if (!periodEnd) continue;
    const periodStart = toDate(r.periodStart) || addDays(shiftMonths(periodEnd, -months), 1);
    const filed = r.filingStatus === 'Completed';
    out.push({
      obligationType: 'VAT_Return',
      // Keep the label the team typed — they recognise their own period names.
      periodLabel: r.period || iso(periodEnd),
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      filingDeadline: iso(due),
      paymentDeadline: iso(due),
      status: filed ? 'filed' : 'pending',
      metadata: {
        derivedFrom: r.periodEnd ? 'vat.returnDates (explicit period)' : 'vat.returnDates (period recovered from due date)',
        monthsPerPeriod: months,
        filingStatus: r.filingStatus || null,
        paymentStatus: r.paymentStatus || null,
        statedFy: r.fy || null
      }
    });
  }
  return out;
}

// ------------------------------------------- Monthly books closure and MIS
//
// These are the firm's own deadlines, not the FTA's, and they're the bulk of
// what a team actually does each month. Unlike VAT and CT they aren't derived
// from a certificate — every month simply falls due, so they're generated from
// the calendar. That's what makes a new month produce its own work without
// anybody opening the tool.
//
// Both default to a day-of-the-following-month deadline, overridable per
// deployment. Books first, then the MIS that reports on them.
const BOOKS_CLOSE_DAY = clampDay(process.env.BOOKS_CLOSE_DAY, 10);
const MIS_ISSUE_DAY   = clampDay(process.env.MIS_ISSUE_DAY, 15);
// How far back to keep raising unclosed months. Without a bound, a client
// onboarded years ago generates an obligation for every month since.
const MONTHLY_LOOKBACK = clampInt(process.env.MONTHLY_LOOKBACK_MONTHS, 6, 1, 60);

function clampDay(v, dflt) {
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 28) ? n : dflt;
}
function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  return (n >= lo && n <= hi) ? n : dflt;
}
function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(d) { return MONTH_NAMES[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }

// The months we should be raising work for: from the engagement start, bounded
// by the lookback, through the current month.
//
// The current month is already the forward-looking one — its books close next
// month — so there's nothing to gain by going further. Raising the month after
// this one just puts work on a list that can't be started for another six
// weeks.
function monthsInPlay(client, today) {
  const now = toDate(today) || new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const earliestAllowed = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHLY_LOOKBACK, 1));

  let start = earliestAllowed;
  const scope = (client && client.scopeStart) || '';
  if (scope) {
    const parts = scope.split('-');
    const scopeDate = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1));
    if (!isNaN(scopeDate) && scopeDate > start) start = scopeDate;
  }

  const out = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= last && out.length < MONTHLY_LOOKBACK + 2) {
    out.push(new Date(cur));
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return out;
}

// A deadline of `day` in the month AFTER the period being reported on.
function dayOfFollowingMonth(periodStart, day) {
  const y = periodStart.getUTCFullYear(), m = periodStart.getUTCMonth();
  const dim = lastDayOfMonth(y, m + 1).getUTCDate();
  return new Date(Date.UTC(y, m + 1, Math.min(day, dim)));
}

function monthlyObligations(client, opts) {
  opts = opts || {};
  if (!client) return [];
  const acct = client.accounting || {};
  const bookStatus = acct.monthlyStatus || {};
  const misStatus = (client.mis && client.mis.monthlyStatus) || {};
  const out = [];

  for (const m of monthsInPlay(client, opts.today)) {
    const key = monthKey(m);
    // A month the firm isn't engaged for owes nothing. isBeforeScope is handled
    // by monthsInPlay; this catches a one-off gap marked by hand.
    if (String(bookStatus[key] || '') === 'Not Applicable') continue;

    const periodStart = m;
    const periodEnd = lastDayOfMonth(m.getUTCFullYear(), m.getUTCMonth());
    const label = monthLabel(m);

    out.push({
      obligationType: 'Books_Closure',
      periodLabel: label,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      filingDeadline: iso(dayOfFollowingMonth(periodStart, BOOKS_CLOSE_DAY)),
      paymentDeadline: null,
      status: String(bookStatus[key] || '') === 'Completed' ? 'filed' : 'pending',
      metadata: { derivedFrom: 'calendar', monthKey: key, internalDeadline: true, closeDay: BOOKS_CLOSE_DAY }
    });

    out.push({
      obligationType: 'MIS_Report',
      periodLabel: label,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      filingDeadline: iso(dayOfFollowingMonth(periodStart, MIS_ISSUE_DAY)),
      paymentDeadline: null,
      status: String(misStatus[key] || '') === 'Issued' ? 'filed' : 'pending',
      metadata: {
        derivedFrom: 'calendar', monthKey: key, internalDeadline: true, issueDay: MIS_ISSUE_DAY,
        // The MIS reports on the month's books, so it can't honestly go out
        // before they're closed. Surfacing the dependency explains a blocked MIS.
        booksClosed: String(bookStatus[key] || '') === 'Completed'
      }
    });
  }
  return out;
}

// ------------------------------------------------------------------ Accounting

// Months the team has NOT yet closed, oldest first. Used to explain why a VAT
// return can't proceed — the UI already blocks filing on this, and the engines
// should be able to say the same thing.
//
// Months before the engagement start (client.scopeStart, 'YYYY-MM') and months
// explicitly marked Not Applicable are excluded: they aren't our work, so they
// must never appear as pending or hold a return open. Both the key and
// scopeStart are zero-padded 'YYYY-MM', so a string compare is a date compare.
function openAccountingMonths(client) {
  const acct = (client && client.accounting) || {};
  const ms = acct.monthlyStatus || {};
  const scopeStart = (client && client.scopeStart) || '';
  return Object.keys(ms)
    .filter(k => !(scopeStart && k < scopeStart))
    .filter(k => {
      const s = String(ms[k] || '');
      return s !== 'Completed' && s !== 'Not Applicable';
    })
    .sort();
}

function allObligations(client, opts) {
  return vatObligations(client, opts)
    .concat(ctObligations(client, opts))
    .concat(monthlyObligations(client, opts));
}

module.exports = {
  ctObligations,
  vatObligations,
  monthlyObligations,
  allObligations,
  openAccountingMonths,
  // exported for tests
  _shiftMonths: shiftMonths,
  _vatMonthsPerPeriod: vatMonthsPerPeriod,
  _vatPeriodEndFromDue: vatPeriodEndFromDue,
  _iso: iso
};
