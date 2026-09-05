// Clear the client list so it can be re-fetched from Ops-Mkt, and remove
// everything derived from it.
//
// Obligations, tasks and escalation events all hang off a client id. Leaving
// them behind would show work for clients that no longer exist, and the engines
// would never clean them up — the sweeps only ever add. They're all regenerated
// from client data on the next sweep, so removing them loses nothing that isn't
// rebuilt.
//
// The people list (teamMembers) is kept: it has nothing to do with clients.
//
// Pass --apply to write. Without it, reports what it would do and changes
// nothing. Take a backup of tracker_state.json first — this script does not.

require('dotenv').config();
const APPLY = process.argv.includes('--apply');
const { initDatabase, tracker } = require('../database');
const { getDdb, tableName } = require('../aws');
const { ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

// Ask the table what its key is rather than assuming 'id'. Most of these tables
// are keyed on a numeric id, but ClientSettings is keyed on client_external_id,
// which is a short alphanumeric string — assuming otherwise produced both a NaN
// and a schema mismatch.
async function keyNamesOf(table) {
  const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
  const raw = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const d = await raw.send(new DescribeTableCommand({ TableName: table }));
  return (d.Table.KeySchema || []).map(k => k.AttributeName);
}

async function scanKeys(table, keyNames) {
  const c = getDdb();
  const rows = [];
  const names = {}, proj = keyNames.map((k, i) => { names['#k' + i] = k; return '#k' + i; }).join(', ');
  let ExclusiveStartKey;
  do {
    const r = await c.send(new ScanCommand({
      TableName: table, ProjectionExpression: proj, ExpressionAttributeNames: names, ExclusiveStartKey
    }));
    (r.Items || []).forEach(i => rows.push(i));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function wipe(suffix) {
  const table = tableName(suffix);
  const keyNames = await keyNamesOf(table);
  const rows = await scanKeys(table, keyNames);
  if (!APPLY) return rows.length;
  const c = getDdb();
  let n = 0;
  for (const row of rows) {
    // Hand back the key values exactly as the scan returned them, under the
    // table's own key names.
    const Key = {};
    keyNames.forEach(k => { Key[k] = row[k]; });
    await c.send(new DeleteCommand({ TableName: table, Key }));
    if (++n % 200 === 0) console.log('    ' + suffix + ': ' + n + '/' + rows.length);
  }
  return n;
}

async function main() {
  await initDatabase();
  const data = tracker.getData();
  const clients = data.clients || [];
  const team = data.teamMembers || [];

  console.log('clients to remove: ' + clients.length);
  console.log('people kept:       ' + team.length + '  (' + team.join(', ') + ')');
  console.log(APPLY ? '\nAPPLYING\n' : '\nDRY RUN — nothing will be written. Re-run with --apply.\n');

  const counts = {};
  for (const s of ['Obligations', 'Tasks', 'EscalationEvents', 'Documents', 'TaskComments', 'ReviewEvents', 'Workflows', 'WorkflowSteps', 'ClientSettings']) {
    counts[s] = await wipe(s);
  }
  Object.entries(counts).forEach(([k, v]) => { if (v) console.log('  ' + (APPLY ? 'removed ' : 'would remove ') + String(v).padStart(4) + '  ' + k); });

  if (!APPLY) { console.log('\nnothing written'); return; }

  await tracker.saveData([], team, 'clear-clients');
  console.log('\nclient list cleared; ' + team.length + ' people kept');
  await new Promise(r => setTimeout(r, 2500));
  console.log('done — use Fetch clients to pull them from Ops-Mkt');
}

main().catch(e => { console.error(e); process.exit(1); });
