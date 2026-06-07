// VAT + CT compliance reporting (one module — same logic, different obligation type).
// Filed-on-time uses obligations.filed_at; overdue = deadline passed and not filed.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');

const COLUMNS = [
  'clientName','periodLabel','filingDeadline','status','filedAt','onTime'
];

async function generateFor(obligationType, period, value) {
  const b = periodHelper.resolveBounds(period, value);
  // Pull obligations whose deadline falls within the period.
  const all = await repos.ObligationsRepo.list({
    type: [obligationType],
    from: b.fromDate, to: b.toDate, limit: 5000
  });

  const rows = all.map(o => {
    const filed = o.status === 'filed';
    const onTime = filed && o.filed_at && o.filing_deadline
      ? (new Date(o.filed_at) <= new Date(o.filing_deadline + 'T23:59:59Z'))
      : (filed ? null : false);
    return {
      obligationId: o.id,
      clientId: o.client_external_id, clientName: o.client_name,
      periodLabel: o.period_label,
      filingDeadline: o.filing_deadline,
      status: o.status,
      filedAt: o.filed_at ? o.filed_at.slice(0, 10) : null,
      onTime
    };
  }).sort((a, b2) => (a.filingDeadline || '').localeCompare(b2.filingDeadline || ''));

  const today = new Date();
  const filed = rows.filter(r => r.status === 'filed');
  const filedOnTime = rows.filter(r => r.onTime === true).length;
  const overdue = rows.filter(r => r.status !== 'filed' && r.filingDeadline && new Date(r.filingDeadline) < today).length;
  const timelinessPct = rows.length ? Math.round((filedOnTime / rows.length) * 100) : null;

  return {
    meta: b, columns: COLUMNS, rows,
    totals: {
      due: rows.length,
      filed: filed.length,
      filedOnTime,
      overdue,
      timelinessPct
    }
  };
}

const vat = { generate: (p, v) => generateFor('VAT_Return', p, v), COLUMNS };
const ct  = { generate: (p, v) => generateFor('CT_Return',  p, v), COLUMNS };

module.exports = { vat, ct, generateFor };
