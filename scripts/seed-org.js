// Seed the firm's reporting structure.
//
//   Saikiran            Super Admin   sees everything
//     Rohini            Admin         Priyanka, Suma, Neha
//     Maneesh           Admin         Lavanya, Nagashree, Reethu, Shreyas, Swathi, Swathi D
//
// Two things this does NOT do, on purpose:
//
//   * It does not create login accounts for people who don't have one. An
//     account's email is its identity, and guessing one produces a broken login
//     somebody then has to find and delete. Accounts are created by inviting
//     from the admin panel, where the role and manager are set at the same time.
//
//   * It does not reassign any client. Ownership is the firm's decision.
//
// Idempotent — safe to re-run.

require('dotenv').config();
const { initDatabase, store, tracker, users } = require('../database');
const roles = require('../roles');

const ORG = {
  superAdmin: 'Sai',                                    // matches the existing account name
  teams: {
    Rohini:  ['Priyanka', 'Suma', 'Neha'],
    Maneesh: ['Lavanya', 'Nagashree', 'Reethu', 'Shreyas', 'Swathi', 'Swathi D']
  }
};

function allOrgNames() {
  const out = [ORG.superAdmin];
  Object.keys(ORG.teams).forEach(lead => { out.push(lead); out.push.apply(out, ORG.teams[lead]); });
  return out;
}

async function main() {
  await initDatabase();

  const before = users.getAll();
  console.log('accounts before:');
  before.forEach(u => console.log('   ' + String(u.name).padEnd(12) + roles.labelOf(u.role).padEnd(13) + (u.email || '')));

  // --- 1. Roles and reporting lines for accounts that already exist ---------
  const byName = {};
  store.users.forEach(u => { byName[u.name] = u; });

  const top = byName[ORG.superAdmin];
  if (!top) {
    console.error('\nNo account named "' + ORG.superAdmin + '" — cannot anchor the hierarchy. Nothing changed.');
    process.exit(1);
  }

  const changes = [];
  if (roles.normalizeRole(top.role) !== 'super_admin' || top.reports_to != null) {
    users.setRoleAndManager(top.id, 'super_admin', null);
    changes.push(top.name + ' -> Super Admin');
  }

  Object.keys(ORG.teams).forEach(leadName => {
    const lead = byName[leadName];
    if (!lead) { console.log('\n   (no account yet for team lead ' + leadName + ' — invite them and set the role then)'); return; }
    if (roles.normalizeRole(lead.role) !== 'admin' || String(lead.reports_to) !== String(top.id)) {
      users.setRoleAndManager(lead.id, 'admin', top.id);
      changes.push(lead.name + ' -> Admin, reporting to ' + top.name);
    }
    ORG.teams[leadName].forEach(execName => {
      const ex = byName[execName];
      if (!ex) return;
      if (roles.normalizeRole(ex.role) !== 'user' || String(ex.reports_to) !== String(lead.id)) {
        users.setRoleAndManager(ex.id, 'user', lead.id);
        changes.push(ex.name + ' -> User, reporting to ' + lead.name);
      }
    });
  });

  // --- 2. Make every org name assignable ------------------------------------
  // Keeps existing entries so nobody's clients become invisible: a client owned
  // by somebody missing from this list disappears from the Team view.
  const data = tracker.getData();
  const existing = data.teamMembers || [];
  const wanted = allOrgNames().filter(n => n !== ORG.superAdmin);   // the manager isn't an assignee
  const merged = existing.slice();
  wanted.forEach(n => { if (merged.indexOf(n) === -1) merged.push(n); });

  const added = merged.filter(n => existing.indexOf(n) === -1);
  // Look for strays among the people who ACTUALLY own clients, not just those
  // listed as assignable. An owner who was never added to the list is the worse
  // case of the two — their clients are already missing from the Team view.
  const owners = {};
  (data.clients || []).forEach(c => {
    const o = c.assignedTeam;
    if (o && o !== 'Unassigned') owners[o] = (owners[o] || 0) + 1;
  });
  const strays = Object.keys(owners).filter(n => wanted.indexOf(n) === -1);

  if (added.length) {
    await tracker.saveData(data.clients, merged, 'seed-org');
  }

  console.log('\nrole changes: ' + (changes.length ? '' : 'none needed'));
  changes.forEach(c => console.log('   ' + c));
  console.log('\nassignable names added: ' + (added.length ? added.join(', ') : 'none'));
  if (strays.length) {
    console.log('\nclient owners NOT in the org chart — their work sits outside the');
    console.log('hierarchy, so it reaches no team lead. Reassign or add them to a team:');
    strays.forEach(n => {
      console.log('   ' + n + '  (' + owners[n] + ' client' + (owners[n] === 1 ? '' : 's') + ')' +
        (existing.indexOf(n) === -1 ? '  — and was never in the assignable list at all' : ''));
    });
  }

  // Who in the org chart has nothing to do yet.
  const idle = wanted.filter(n => !owners[n]);
  if (idle.length) console.log('\nin the org chart but holding no clients: ' + idle.join(', '));

  const after = users.getAll();
  console.log('\naccounts after:');
  after.forEach(u => {
    const mgr = u.reports_to != null ? (after.find(x => String(x.id) === String(u.reports_to)) || {}).name : '—';
    console.log('   ' + String(u.name).padEnd(12) + roles.labelOf(u.role).padEnd(13) + 'reports to: ' + (mgr || '—'));
  });

  // Give the fire-and-forget DynamoDB writes a moment to land before exit.
  await new Promise(r => setTimeout(r, 2500));
  console.log('\ndone');
}

main().catch(e => { console.error(e); process.exit(1); });
