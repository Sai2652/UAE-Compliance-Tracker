// Repair the damage left by the escalation dedupe bug.
//
// hasOpenFor() used Limit:1 with a FilterExpression. DynamoDB applies the limit
// to the rows it READS and filters afterwards, so it kept reading one event for
// a task, finding it belonged to a different rule, and concluding "nothing open
// here" — re-escalating the same task every hour. 39 tasks reached
// escalation_level 18 and the table holds hundreds of duplicate events.
//
// The bug is fixed (repositories/index.js). This cleans up after it:
//
//   1. Collapse the events to one per (task, rule) — the oldest, which is when
//      the escalation genuinely happened — and delete the rest.
//   2. Reset each task's escalation_level to the number of distinct rules that
//      actually fired for it.
//
// Also clears the 'escalated' work status that the old engine wrote over the
// real one. It no longer does that, but existing rows still carry it and there
// is no way to recover what they were, so they go back to 'not_started' —
// truthful for this data, where nothing has been started.
//
// Pass --apply to write. Without it, reports what it would do and changes
// nothing.

require('dotenv').config();
const APPLY = process.argv.includes('--apply');
const { getDdb, tableName } = require('../aws');
const { ScanCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

async function scanAll(table) {
  const c = getDdb();
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await c.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    if (r.Items) out.push.apply(out, r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function main() {
  const c = getDdb();
  if (!c) { console.error('DynamoDB not configured'); process.exit(1); }

  const events = await scanAll(tableName('EscalationEvents'));
  const tasks = await scanAll(tableName('Tasks'));
  console.log('events: ' + events.length + '   tasks: ' + tasks.length);
  console.log(APPLY ? '\nAPPLYING\n' : '\nDRY RUN — nothing will be written. Re-run with --apply.\n');

  // ---- 1. one event per (task, rule), keeping the earliest ----
  const groups = new Map();
  events.forEach(e => {
    const key = String(e.task_id) + '|' + String(e.rule_id);
    const list = groups.get(key) || [];
    list.push(e);
    groups.set(key, list);
  });

  const doomed = [];
  const rulesPerTask = new Map();
  groups.forEach((list, key) => {
    list.sort((a, b) => String(a.triggered_at || '').localeCompare(String(b.triggered_at || '')));
    list.slice(1).forEach(e => doomed.push(e));
    const taskId = key.split('|')[0];
    rulesPerTask.set(taskId, (rulesPerTask.get(taskId) || 0) + 1);
  });

  console.log('distinct (task, rule) pairs: ' + groups.size);
  console.log('duplicate events to delete:  ' + doomed.length);

  // ---- 2. task fields to correct ----
  const fixes = [];
  tasks.forEach(t => {
    const want = rulesPerTask.get(String(t.id)) || 0;
    const haveLevel = Number(t.escalation_level || 0);
    const patch = {};
    if (haveLevel !== want) patch.escalation_level = want;
    if (t.status === 'escalated') patch.status = 'not_started';
    if (Object.keys(patch).length) fixes.push({ id: t.id, patch, from: { level: haveLevel, status: t.status } });
  });

  const levelChanges = fixes.filter(f => 'escalation_level' in f.patch);
  const statusChanges = fixes.filter(f => 'status' in f.patch);
  console.log('tasks with a wrong escalation_level: ' + levelChanges.length);
  console.log('tasks still carrying status=escalated: ' + statusChanges.length);
  if (levelChanges.length) {
    const worst = levelChanges.slice().sort((a, b) => b.from.level - a.from.level)[0];
    console.log('  worst case: task ' + worst.id + ' level ' + worst.from.level + ' -> ' + worst.patch.escalation_level);
  }

  if (!APPLY) {
    console.log('\nnothing written');
    return;
  }

  let deleted = 0;
  for (const e of doomed) {
    await c.send(new DeleteCommand({ TableName: tableName('EscalationEvents'), Key: { id: Number(e.id) } }));
    if (++deleted % 100 === 0) console.log('  deleted ' + deleted + '/' + doomed.length);
  }
  console.log('deleted ' + deleted + ' duplicate event(s)');

  let patched = 0;
  for (const f of fixes) {
    const names = {}, values = {}, sets = [];
    Object.keys(f.patch).forEach((k, i) => {
      names['#f' + i] = k; values[':v' + i] = f.patch[k]; sets.push('#f' + i + ' = :v' + i);
    });
    await c.send(new UpdateCommand({
      TableName: tableName('Tasks'),
      Key: { id: Number(f.id) },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    }));
    patched++;
  }
  console.log('corrected ' + patched + ' task(s)');
}

main().catch(e => { console.error(e); process.exit(1); });
