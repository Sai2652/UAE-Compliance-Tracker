// Document Delay Analysis — aging buckets + most-common missing docs.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');
const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

const COLUMNS = [
  'clientName','documentName','requestedDate','pendingDays','remindersSent','requestedBy','agingBucket'
];

async function generate(period, value) {
  const b = periodHelper.resolveBounds(period, value);
  const all = await repos.DocumentsRepo.listPending();

  const rows = all.map(d => {
    const days = daysAgo(d.requested_date) || 0;
    const bucket = days > 30 ? '>30d' : days > 14 ? '>14d' : days > 7 ? '>7d' : '≤7d';
    return {
      docId: d.id,
      clientId: d.client_external_id, clientName: d.client_name,
      documentName: d.document_name,
      requestedDate: d.requested_date ? d.requested_date.slice(0, 10) : null,
      pendingDays: days,
      remindersSent: d.reminder_count || 0,
      requestedBy: d.requested_by_name || null,
      agingBucket: bucket
    };
  }).sort((a, b2) => b2.pendingDays - a.pendingDays);

  // Aggregates
  const buckets = { '>7d': 0, '>14d': 0, '>30d': 0 };
  rows.forEach(r => {
    if (r.pendingDays > 7)  buckets['>7d']++;
    if (r.pendingDays > 14) buckets['>14d']++;
    if (r.pendingDays > 30) buckets['>30d']++;
  });
  const avgDelay = rows.length ? Math.round((rows.reduce((s, r) => s + r.pendingDays, 0) / rows.length) * 10) / 10 : 0;

  // Top contributing clients + most common missing docs
  const byClient = {}; rows.forEach(r => { (byClient[r.clientName] = byClient[r.clientName] || []).push(r); });
  const topClients = Object.entries(byClient).map(([name, list]) => ({
    clientName: name, count: list.length, oldestDays: Math.max(...list.map(x => x.pendingDays))
  })).sort((a, b2) => b2.count - a.count).slice(0, 10);

  const byDoc = {}; rows.forEach(r => { byDoc[r.documentName] = (byDoc[r.documentName] || 0) + 1; });
  const topDocs = Object.entries(byDoc).map(([name, count]) => ({ documentName: name, count })).sort((a, b2) => b2.count - a.count).slice(0, 10);

  return { meta: b, columns: COLUMNS, rows, totals: { total: rows.length, avgDelayDays: avgDelay, buckets }, topClients, topDocs };
}

module.exports = { generate, COLUMNS };
