// RFC-4180 CSV writer. Pure, no dependencies.
//
// Usage:
//   const { toCSV } = require('./csvWriter');
//   toCSV([{name:'A', value:1}], ['name', 'value'])
//     → "name,value\r\nA,1\r\n"

function escapeCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Strip the UTF-8 BOM if present.
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCSV(rows, columns, options) {
  const opts = options || {};
  const maxRows = opts.maxRows || 10000;
  const truncated = rows.length > maxRows;
  const slice = truncated ? rows.slice(0, maxRows) : rows;

  let cols = columns;
  if (!cols || !cols.length) {
    // Derive from first row's keys.
    cols = slice.length ? Object.keys(slice[0]) : [];
  }
  const lines = [cols.map(escapeCell).join(',')];
  for (const r of slice) {
    lines.push(cols.map(c => escapeCell(r[c])).join(','));
  }
  if (truncated) lines.push(`# truncated_at,${maxRows}`);
  return lines.join('\r\n') + '\r\n';
}

// Helper: turn a service result + UI column list into a download-friendly
// filename (no spaces, no slashes).
function filenameFor(reportKey, label) {
  const safe = String(label || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${reportKey}-${safe || 'report'}.csv`;
}

module.exports = { toCSV, escapeCell, filenameFor };
