// Read-only bridge to the Ops-Mkt tracker.
//
// Ops-Mkt is the firm's master client register — every client the firm has
// signed sits there, with the First POC who owns the relationship. This
// tracker used to have its own hand-typed list, which drifted the moment a
// new client was signed. So instead of re-typing, we read Ops-Mkt.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
//  1. It never writes to Ops-Mkt. Not a row, not a field, not a flag. Every
//     statement goes through q(), which refuses anything that is not a
//     SELECT. Ops-Mkt is another team's system of record and a bug here must
//     not be able to damage it.
//  2. It never invents a client. A row is either matched to something already
//     in the tracker (and skipped) or added with its Ops-Mkt id recorded, so
//     the same client cannot arrive twice under two spellings of its name.
//
// Ops-Mkt keeps its state as chunked JSON in an Aurora Postgres table
// (app_state: key, sequence, jsonb value) reached over the RDS Data API — no
// VPC, no connection pool, just an HTTPS call. The client list is the
// 'masterClients' key, split into pages of 25.

var { RDSDataClient, ExecuteStatementCommand } = require('@aws-sdk/client-rds-data');
var crypto = require('crypto');
var entityTypes = require('../entityTypes');

var REGION = process.env.OPSMKT_REGION || process.env.AWS_REGION || 'ap-south-1';
var CLUSTER_ARN = process.env.OPSMKT_CLUSTER_ARN || 'arn:aws:rds:ap-south-1:333973504173:cluster:opsmkt-pg';
var SECRET_ARN = process.env.OPSMKT_SECRET_ARN || '';
var DB = process.env.OPSMKT_DB || 'postgres';
var STATE_KEY = process.env.OPSMKT_STATE_KEY || 'masterClients';

var client = null;
function rds() {
  if (!client) client = new RDSDataClient({ region: REGION });
  return client;
}

function configured() {
  return !!(CLUSTER_ARN && SECRET_ARN);
}

// Every read goes through here. The SELECT check is not defensive theatre —
// this module holds credentials that can write to another team's production
// database, and the only thing standing between a future edit and that
// database is this line.
async function q(sql, params) {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error('opsMktSync is read-only — refusing a non-SELECT statement');
  }
  if (!configured()) throw new Error('Ops-Mkt link is not configured (OPSMKT_CLUSTER_ARN / OPSMKT_SECRET_ARN).');
  var out = await rds().send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DB,
    sql: sql,
    parameters: params || []
  }));
  return out.records || [];
}

function strParam(name, value) {
  return { name: name, value: { stringValue: String(value) } };
}

// ---------------------------------------------------------------------------
// Reading the master client list
// ---------------------------------------------------------------------------

// The eleven fields this tracker actually needs from an Ops-Mkt client row.
// Everything else on those rows — billing, fees, discounts, lead history,
// passport expiry — is none of this tool's business, so it is never read.
//
// Projecting in SQL rather than pulling whole rows is also what keeps this
// working at all: the Data API refuses a result over 1 MB, and the full
// client blob is larger than that. Unnesting the chunks and selecting eleven
// columns brings 434 clients back in a single call.
var FIELD_SQL = [
  "e->>'id' as ops_id",
  "e->>'company' as company",
  "e->>'clientName' as client_name",
  "e->>'team' as team",
  "e->>'member' as member",
  "e->>'spoc' as spoc",
  "e->>'status' as status",
  "e->>'category' as category",
  "e->>'vatRegStatus' as vat_reg_status",
  "e->>'trn' as trn",
  "e->>'natureOfBusiness' as nature_of_business"
].join(', ');

var FIELD_ORDER = ['id', 'company', 'clientName', 'team', 'member', 'spoc',
  'status', 'category', 'vatRegStatus', 'trn', 'natureOfBusiness'];

// Returns one plain object per Ops-Mkt client. The chunk rows are unnested in
// SQL, so chunk ordering cannot shuffle anything.
async function readMasterClients() {
  var recs = await q(
    'select ' + FIELD_SQL + ' from app_state cross join jsonb_array_elements(v) e ' +
    'where k = :k order by 2',
    [strParam('k', STATE_KEY)]
  );
  return recs.map(function(rec) {
    var row = {};
    FIELD_ORDER.forEach(function(field, i) {
      var cell = rec[i] || {};
      row[field] = cell.isNull ? '' : (cell.stringValue == null ? '' : cell.stringValue);
    });
    return row;
  });
}

// The First POC is stored on the Ops-Mkt row as 'team' — it is the partner or
// lead who owns the client relationship (Maneesh, Madhu, Sai Kiran, and so
// on), which is exactly what the column is labelled in their grid.
function pocOf(row) {
  return String((row && row.team) || '').trim();
}

function isActive(row) {
  return /^active/i.test(String((row && row.status) || '').trim());
}

// The picker list: who the First POCs are and how many clients each carries,
// so the person choosing knows what they are about to pull in.
async function listFirstPocs() {
  var rows = await readMasterClients();
  var byPoc = {};
  rows.forEach(function(r) {
    var poc = pocOf(r) || '(no First POC set)';
    if (!byPoc[poc]) byPoc[poc] = { poc: poc, total: 0, active: 0 };
    byPoc[poc].total++;
    if (isActive(r)) byPoc[poc].active++;
  });
  return Object.keys(byPoc)
    .map(function(k) { return byPoc[k]; })
    .sort(function(a, b) { return b.active - a.active || a.poc.localeCompare(b.poc); });
}

// ---------------------------------------------------------------------------
// Turning an Ops-Mkt row into a tracker client
// ---------------------------------------------------------------------------

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DOCS_LIST = ['COI', 'Trade License', 'BCL Mandate', 'MOA', 'AOA', 'Ejari', 'Establishment Card',
  'Shareholders Passport', 'Shareholder Emirates ID', 'FTA Login', 'CT Registration',
  'VAT Registration', 'Signed KYC'];
var DEFAULT_PORTALS = ['FTA Portal', 'Zoho Books'];
var PORTAL_URLS = { 'FTA Portal': 'https://eservices.tax.gov.ae/#/Logon', 'Zoho Books': 'https://books.zoho.com/' };

function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

// Ops-Mkt records VAT as Registered / Pending / NA. The tracker needs one of
// its own VAT_OPTIONS values, and getting this wrong is expensive in both
// directions: mark a registered client "No" and its returns disappear from
// the tracker; mark an unregistered one "Yes" and the team chases filings
// that do not exist. So only an explicit "Registered" becomes Yes.
function vatFromOpsMkt(row) {
  var s = String((row && row.vatRegStatus) || '').trim().toLowerCase();
  if (s === 'registered') return 'Yes';
  if (s.indexOf('pending') === 0) return 'Pending - Registration in Progress';
  return 'No';
}

// Ops-Mkt carries far more team members than this tracker has users, because
// it covers the whole firm. Only map a name we actually know; anything else
// stays Unassigned with the Ops-Mkt name kept alongside as a hint, so nobody
// has to go and look it up.
function teamFromOpsMkt(row, knownMembers) {
  var member = String((row && row.member) || '').trim();
  if (!member) return 'Unassigned';
  var hit = (knownMembers || []).find(function(m) {
    var name = typeof m === 'string' ? m : (m && m.name) || '';
    return name.toLowerCase() === member.toLowerCase();
  });
  if (!hit) return 'Unassigned';
  return typeof hit === 'string' ? hit : hit.name;
}

// A faithful port of createBlankClient() in app.html. It has to stay in step
// with that function: the nightly sync runs on the server with no browser, so
// the shape cannot be built in the page. Anything added to the client record
// there needs adding here too, or synced clients arrive missing a field.
function buildClientFromOpsMkt(row, opts) {
  opts = opts || {};
  var name = String((row && (row.company || row.clientName)) || '').trim();
  var vatVal = vatFromOpsMkt(row);
  var fy = opts.financialYear || '2025';
  var ctDue = opts.ctDueDate || '2026-09-30';
  var ctFY = String(parseInt(ctDue.substring(0, 4), 10) - 1);
  var team = teamFromOpsMkt(row, opts.teamMembers);

  var guessed = entityTypes.guessEntityTypeFromName(name);
  var today = new Date().toISOString().slice(0, 10);

  return {
    id: uid(),
    name: name,
    // A guess from the company name, flagged so the UI can ask for it to be
    // checked against the trade licence. Never presented as confirmed.
    entityType: guessed || 'Not Recorded',
    entityTypeGuessed: !!guessed,
    businessNature: entityTypes.normalizeBusinessNature(row && row.natureOfBusiness),
    assignedTeam: team,
    vatApplicable: vatVal,
    trn: String((row && row.trn) || '').trim(),
    ctApplicable: true,
    scopeStart: '',
    accounting: {
      financialYear: fy,
      monthlyStatus: MONTHS.reduce(function(a, m, i) {
        a[fy + '-' + String(i + 1).padStart(2, '0')] = 'Not Started';
        return a;
      }, {})
    },
    mis: { monthlyStatus: {} },
    vat: { periods: [], returnDates: [] },
    ct: { financialYear: ctFY, dueDate: ctDue, status: 'Not Started', assignedPerson: team, notes: '' },
    documents: DOCS_LIST.reduce(function(a, d) {
      a[d] = (d === 'VAT Registration' && vatVal === 'No') ? 'N/A' : 'Pending';
      return a;
    }, {}),
    logins: DEFAULT_PORTALS.map(function(p) {
      return { id: uid(), name: p, url: PORTAL_URLS[p] || '', enabled: false, username: '', password: '', createdAt: '', lastModified: '' };
    }),
    blockedReasons: {},
    lastUpdated: today,
    lastUpdatedBy: 'Ops-Mkt sync',
    // Provenance. opsMkt.id is what dedupes on every later sync — matching on
    // the company name alone would double up the moment Ops-Mkt fixes a typo.
    opsMkt: {
      id: String((row && row.id) || ''),
      firstPoc: pocOf(row),
      member: String((row && row.member) || ''),
      spoc: String((row && row.spoc) || ''),
      status: String((row && row.status) || ''),
      category: String((row && row.category) || ''),
      clientName: String((row && row.clientName) || ''),
      syncedAt: new Date().toISOString()
    }
  };
}

// ---------------------------------------------------------------------------
// Working out what to add
// ---------------------------------------------------------------------------

// Loose name match, only used to avoid duplicating a client someone already
// typed in by hand. Legal-form suffixes are stripped because "Al Noor
// Trading LLC" and "Al Noor Trading L.L.C" are the same company.
function normName(s) {
  return String(s || '').toLowerCase()
    // Punctuation is REMOVED, not turned into a space. Spacing it out was a
    // duplicate-client bug: "Access L.L.C." became "access l l c", which no
    // longer looked anything like "Access LLC" ("access"), so the same
    // company would have been imported a second time. Deleting the dots
    // collapses the acronym back to "llc" where the suffix pattern can see it.
    .replace(/[.,()'"`]/g, '')
    // Spaces inside the acronyms are tolerated too, for the people who type
    // "Gulf Star F Z C O".
    .replace(/\b(l\s*l\s*c|f\s*z\s*c\s*o?|fz-?llc|f\s*z\s*e|w\s*l\s*l|dmcc|ltd|limited|inc|incorporated|dwc|fz|jlt|est|establishment|company|co)\b/g, ' ')
    .replace(/[\s\-_&+]+/g, ' ')
    .trim();
}

// Decide, without touching anything, what a fetch or sync would do. Returns
// the clients it would add plus a reason for every row it would not, so the
// caller can show the user the whole picture before committing.
async function plan(options) {
  var opts = options || {};
  var wantPocs = (opts.pocs || []).map(function(p) { return String(p).trim().toLowerCase(); });
  var activeOnly = opts.activeOnly !== false;
  var existing = opts.existingClients || [];

  var rows = await readMasterClients();

  var haveOpsIds = {};
  var haveNames = {};
  existing.forEach(function(c) {
    var oid = c && c.opsMkt && c.opsMkt.id;
    if (oid) haveOpsIds[String(oid)] = c;
    var n = normName(c && c.name);
    if (n) haveNames[n] = c;
  });

  var toAdd = [];
  var skipped = [];
  var seenThisRun = {};

  rows.forEach(function(r) {
    var poc = pocOf(r);
    if (wantPocs.length && wantPocs.indexOf(poc.toLowerCase()) === -1) return;   // not asked for — not a skip worth reporting
    var name = String((r && (r.company || r.clientName)) || '').trim();
    if (!name) { skipped.push({ name: '(no name)', reason: 'Ops-Mkt row has no company name' }); return; }
    if (activeOnly && !isActive(r)) { skipped.push({ name: name, poc: poc, reason: 'not active in Ops-Mkt (' + (r.status || 'no status') + ')' }); return; }

    var oid = String((r && r.id) || '');
    if (oid && haveOpsIds[oid]) { skipped.push({ name: name, poc: poc, reason: 'already in the tracker' }); return; }
    var nn = normName(name);
    if (nn && haveNames[nn]) { skipped.push({ name: name, poc: poc, reason: 'already in the tracker as "' + haveNames[nn].name + '"' }); return; }
    // Ops-Mkt itself can hold the same company twice; do not import both.
    if (nn && seenThisRun[nn]) { skipped.push({ name: name, poc: poc, reason: 'listed twice in Ops-Mkt' }); return; }
    if (nn) seenThisRun[nn] = true;

    toAdd.push(buildClientFromOpsMkt(r, { teamMembers: opts.teamMembers }));
  });

  return { toAdd: toAdd, skipped: skipped, scanned: rows.length };
}

module.exports = {
  configured: configured,
  readMasterClients: readMasterClients,
  listFirstPocs: listFirstPocs,
  buildClientFromOpsMkt: buildClientFromOpsMkt,
  plan: plan,
  normName: normName,
  pocOf: pocOf,
  isActive: isActive
};
