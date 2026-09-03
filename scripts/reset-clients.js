// Empty the client list so it can be rebuilt from Ops-Mkt.
//
// This is destructive and deliberately awkward to run. Default is a dry run
// that prints exactly what would go and how much recorded work sits on it;
// nothing is touched without --confirm.
//
//   node scripts/reset-clients.js                 # dry run — safe, prints a report
//   node scripts/reset-clients.js --confirm       # actually does it
//
// Before deleting anything it writes a full JSON export of every client and
// every obligation and task about to be removed, to ./.backups locally AND to
// the S3 bucket. That export is the undo: the client list is a single S3
// object, so restoring it is a copy back.
//
// What goes: the clients, and the obligations and tasks generated from them.
// What stays: users, the activity log, escalation rules, SLA policies and all
// the other configuration — none of that is per-client, and throwing away the
// audit trail of what was done is not part of starting the client list again.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { initDatabase, tracker } = require('../database');
  const { obligations } = require('../obligations');
  const compliance = require('../compliance');
  const aws = require('../aws');

  await initDatabase();
  const data = tracker.getData();
  const clients = data.clients || [];

  if (!clients.length) {
    console.log('The client list is already empty — nothing to do.');
    return;
  }

  // How much real work is recorded. This is the number that decides whether
  // wiping is cheap or expensive, so it is printed before anything happens.
  let monthsWorked = 0, vatRows = 0, ctStarted = 0, docsReceived = 0, loginsSaved = 0;
  clients.forEach(function(c) {
    monthsWorked += Object.values((c.accounting && c.accounting.monthlyStatus) || {}).filter(function(v) { return v && v !== 'Not Started'; }).length;
    vatRows += ((c.vat && c.vat.returnDates) || []).length;
    if (c.ct && c.ct.status && c.ct.status !== 'Not Started') ctStarted++;
    docsReceived += Object.values(c.documents || {}).filter(function(v) { return v === 'Received'; }).length;
    loginsSaved += ((c.logins) || []).filter(function(l) { return l && l.enabled && l.username; }).length;
  });

  const allObligations = await obligations.list({});
  const allTasks = await compliance.tasks.list({});
  const ids = new Set(clients.map(function(c) { return String(c.id); }));
  const myObligations = (allObligations || []).filter(function(o) { return ids.has(String(o.client_external_id)); });
  const myTasks = (allTasks || []).filter(function(t) { return ids.has(String(t.client_external_id)); });

  console.log('');
  console.log('  Clients to remove      : ' + clients.length);
  console.log('  Obligations to remove  : ' + myObligations.length + ' (of ' + (allObligations || []).length + ' total)');
  console.log('  Tasks to remove        : ' + myTasks.length + ' (of ' + (allTasks || []).length + ' total)');
  console.log('');
  console.log('  Recorded work that would be lost:');
  console.log('    months worked        : ' + monthsWorked);
  console.log('    VAT return rows      : ' + vatRows);
  console.log('    clients past CT start: ' + ctStarted);
  console.log('    documents received   : ' + docsReceived);
  console.log('    portal logins saved  : ' + loginsSaved);
  console.log('');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = JSON.stringify({
    takenAt: new Date().toISOString(),
    clients: clients,
    teamMembers: data.teamMembers || [],
    obligations: myObligations,
    tasks: myTasks
  }, null, 2);

  if (!CONFIRM) {
    console.log('  DRY RUN — nothing was changed. Re-run with --confirm to go ahead.');
    return;
  }

  // Export first, always. If the export cannot be written, the delete does
  // not happen — an irreversible delete with no copy of what went is not a
  // trade worth making for a few seconds.
  const dir = path.join(__dirname, '..', '.backups');
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, 'clients-before-reset-' + stamp + '.json');
  fs.writeFileSync(local, dump);
  console.log('  Local export : ' + local);

  const s3 = aws.getS3();
  const bucket = aws.bucketName();
  if (s3 && bucket) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = 'backups/clients-before-reset-' + stamp + '.json';
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: dump, ContentType: 'application/json' }));
    console.log('  S3 export    : s3://' + bucket + '/' + key);
  } else {
    throw new Error('No S3 bucket configured — refusing to delete without an off-machine copy.');
  }

  // Obligations and tasks first, then the clients. In that order a failure
  // part-way leaves orphaned rows pointing at clients that still exist, which
  // the nightly sweep tidies. The other order would leave rows pointing at
  // clients that are gone.
  let obDeleted = 0;
  for (const c of clients) {
    try { await obligations.deleteForClient(c.id); obDeleted++; }
    catch (e) { console.error('  ! obligations for ' + c.name + ': ' + e.message); }
  }
  let taskDeleted = 0;
  for (const t of myTasks) {
    try { await compliance.tasks.delete(t.id); taskDeleted++; }
    catch (e) { console.error('  ! task ' + t.id + ': ' + e.message); }
  }

  await tracker.saveData([], data.teamMembers || [], 'client list reset');

  console.log('');
  console.log('  Done. Clients cleared for ' + obDeleted + ' client(s), ' + taskDeleted + ' task(s) deleted.');
  console.log('  The team list was kept. Fetch clients from Ops-Mkt to rebuild the list.');
}

main().then(function() { process.exit(0); })
  .catch(function(e) { console.error('FAILED:', e); process.exit(1); });
