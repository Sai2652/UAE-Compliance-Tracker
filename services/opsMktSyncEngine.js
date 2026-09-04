// Pulling clients across from Ops-Mkt, and keeping up with new ones.
//
// Two entry points, both landing in the same place:
//
//   fetchForPocs()  — someone picked First POCs in the UI and pressed Fetch.
//   runAutoSync()   — the nightly sweep, using whatever POCs were picked last
//                     time, so a client signed today is in the tracker
//                     tomorrow without anyone remembering to press anything.
//
// Neither one ever removes or edits a client. A client disengaged in Ops-Mkt
// is left exactly as it is here, because its filings and history are still
// this team's work and its record is still the evidence of that. Additions
// only — anything else is a decision for a person.

var opsMkt = require('./opsMktSync');
var { OpsMktSyncRepo } = require('../repositories/opsMktSyncRepo');
var { tracker, activity, users } = require('../database');
var obligationEngine = require('../obligationEngine');

// Add the planned clients to the tracker and seed their obligations.
//
// The obligation seeding is what turns a name into work: without it a synced
// client sits in the list with no VAT returns and no CT deadline, and looks
// complete when nothing has been done. It runs per client and failures are
// logged rather than thrown — one client with an odd financial year must not
// stop the other sixty from arriving.
// budgetMs caps how long obligation seeding may run. It exists because the
// API route lives behind an HTTP API, which cuts every request off at 30
// seconds — a hard AWS limit, not a setting. Seeding 63 clients one at a time
// does not fit in that, so the request seeds what it can and says how many
// are left; the nightly obligation sweep covers every client anyway, so the
// remainder is picked up by morning. The cron path passes no budget.
async function commit(plan, actor, budgetMs) {
  var data = tracker.getData();
  var merged = (data.clients || []).concat(plan.toAdd);
  // The client list is saved first and in one write. If the seeding below runs
  // out of time, the clients are still safely recorded — the reverse order
  // would risk obligations pointing at clients that were never stored.
  await tracker.saveData(merged, data.teamMembers || [], actor || 'Ops-Mkt sync');

  // One line for the whole import, not one per client. The activity feed
  // keeps the most recent 200 entries, and a 63-client fetch logged
  // individually would push everything else off the page — which is the
  // opposite of what an audit trail is for. The names go in the detail.
  try {
    var names = plan.toAdd.map(function(c) { return c.name; });
    var shown = names.slice(0, 12).join(', ');
    activity.log(null, actor || 'Ops-Mkt sync', 'clients_synced',
      'Added ' + names.length + ' client(s) from Ops-Mkt: ' + shown + (names.length > 12 ? ' and ' + (names.length - 12) + ' more' : ''));
  } catch (e) { /* the audit line is not worth failing the import over */ }

  var seeded = 0, deferred = 0;
  var stopAt = budgetMs ? Date.now() + budgetMs : null;
  for (var i = 0; i < plan.toAdd.length; i++) {
    if (stopAt && Date.now() > stopAt) { deferred = plan.toAdd.length - i; break; }
    try {
      await obligationEngine.regenerateForClient(plan.toAdd[i].id);
      seeded++;
    } catch (e) {
      // One client with an odd financial year must not stop the other sixty
      // from arriving, and the nightly sweep retries it anyway.
      console.error('[opsMktSync] obligations for ' + plan.toAdd[i].name + ':', e.message);
    }
  }
  return { added: plan.toAdd.length, seeded: seeded, deferred: deferred, skipped: plan.skipped.length };
}

// What a fetch would do, without doing it. The UI shows this first so nobody
// imports sixty clients to find out what they were.
async function preview(options) {
  var opts = options || {};
  var data = tracker.getData();
  // Match Ops-Mkt's team member against people who can actually sign in.
  // This used to match against the old teamMembers name list, which meant a
  // synced client could land on somebody with no account — work assigned to
  // a person who cannot open the tool.
  var assignable = (users.getAll() || [])
    .filter(function(u) { return u && u.active !== false && u.name; })
    .map(function(u) { return u.name; });
  return await opsMkt.plan({
    pocs: opts.pocs || [],
    activeOnly: opts.activeOnly !== false,
    existingClients: data.clients || [],
    teamMembers: assignable
  });
}

// The Fetch button. Remembers the POC selection so the nightly sweep knows
// what to follow from here on.
async function fetchForPocs(options) {
  var opts = options || {};
  var pocs = (opts.pocs || []).filter(Boolean);
  if (!pocs.length) throw new Error('Pick at least one First POC to fetch.');

  var plan = await preview({ pocs: pocs, activeOnly: opts.activeOnly !== false });
  var result = plan.toAdd.length ? await commit(plan, opts.actor, opts.budgetMs) : { added: 0, seeded: 0, deferred: 0, skipped: plan.skipped.length };

  var settings = await OpsMktSyncRepo.load();
  // Union, not replace: fetching Madhu's clients today should not stop the
  // sweep following Maneesh's, picked last week.
  var union = settings.pocs.slice();
  pocs.forEach(function(p) { if (union.indexOf(p) === -1) union.push(p); });
  await OpsMktSyncRepo.save(Object.assign({}, settings, {
    pocs: union,
    activeOnly: opts.activeOnly !== false,
    autoSync: opts.autoSync !== undefined ? !!opts.autoSync : settings.autoSync,
    lastSyncAt: new Date().toISOString(),
    lastSyncResult: { added: result.added, skipped: result.skipped, at: new Date().toISOString(), by: opts.actor || 'Fetch' }
  }));

  return Object.assign({}, result, { scanned: plan.scanned, skippedDetail: plan.skipped.slice(0, 200), pocs: union });
}

// The Refresh button and the nightly sweep. Same work, different trigger.
async function runAutoSync(options) {
  var opts = options || {};
  var settings = await OpsMktSyncRepo.load();
  if (!settings.pocs.length) return { added: 0, skipped: 0, note: 'No First POC selected yet — nothing to sync.' };
  // A manual Refresh runs even when the nightly sweep is switched off; that
  // switch is about unattended changes, not about the button.
  if (!settings.autoSync && !opts.manual) return { added: 0, skipped: 0, note: 'Automatic sync is switched off.' };

  var plan = await preview({ pocs: settings.pocs, activeOnly: settings.activeOnly });
  var result = plan.toAdd.length ? await commit(plan, opts.actor || 'Ops-Mkt auto-sync', opts.budgetMs) : { added: 0, seeded: 0, deferred: 0, skipped: plan.skipped.length };

  await OpsMktSyncRepo.save(Object.assign({}, settings, {
    lastSyncAt: new Date().toISOString(),
    lastSyncResult: { added: result.added, skipped: result.skipped, at: new Date().toISOString(), by: opts.actor || 'auto-sync' }
  }));

  return Object.assign({}, result, {
    scanned: plan.scanned,
    pocs: settings.pocs,
    newNames: plan.toAdd.map(function(c) { return c.name; }).slice(0, 50)
  });
}

async function status() {
  var settings = await OpsMktSyncRepo.load();
  var data = tracker.getData();
  var fromOps = (data.clients || []).filter(function(c) { return c && c.opsMkt && c.opsMkt.id; }).length;
  return {
    configured: opsMkt.configured(),
    pocs: settings.pocs,
    activeOnly: settings.activeOnly,
    autoSync: settings.autoSync,
    lastSyncAt: settings.lastSyncAt,
    lastSyncResult: settings.lastSyncResult,
    trackerClients: (data.clients || []).length,
    fromOpsMkt: fromOps
  };
}

async function setSettings(patch) {
  var settings = await OpsMktSyncRepo.load();
  var next = Object.assign({}, settings);
  if (patch && Array.isArray(patch.pocs)) next.pocs = patch.pocs.filter(Boolean);
  if (patch && patch.autoSync !== undefined) next.autoSync = !!patch.autoSync;
  if (patch && patch.activeOnly !== undefined) next.activeOnly = !!patch.activeOnly;
  await OpsMktSyncRepo.save(next);
  return next;
}

module.exports = {
  preview: preview,
  fetchForPocs: fetchForPocs,
  runAutoSync: runAutoSync,
  status: status,
  setSettings: setSettings
};
