// Export dispatcher. Each report passes rows + columns + a default filename;
// dispatcher writes the response based on ?format=.
// CSV ships now. XLSX and PDF return 501 with a clear message; the API shape
// is stable so adding those later requires no route changes.

const { toCSV, filenameFor } = require('./csvWriter');

function send(req, res, opts) {
  const fmt = (req.query.format || 'json').toLowerCase();
  const { reportKey, label, columns, rows, payload } = opts;

  if (fmt === 'csv') {
    const csv = toCSV(rows || [], columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filenameFor(reportKey, label) + '"');
    return res.send(csv);
  }
  if (fmt === 'xlsx' || fmt === 'pdf') {
    return res.status(501).json({
      error: fmt.toUpperCase() + ' export is reserved for a future release. CSV is available now.'
    });
  }
  // Default JSON (full payload + metadata)
  return res.json(payload || { rows: rows || [], columns: columns || [], label });
}

module.exports = { send };
