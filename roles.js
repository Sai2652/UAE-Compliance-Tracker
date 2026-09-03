// Roles and visibility — the single place that decides who can see which client.
//
// Three roles, matching the labels used in AutoLedger so the two tools read the
// same way:
//
//   super_admin  "Super Admin"  the manager. Sees every client and every team.
//   admin        "Admin"        a team lead. Sees their own clients and those of
//                               everyone reporting to them.
//   user         "User"         an executive. Sees only their own clients.
//
// The hierarchy is one level of reporting: each admin reports to the super
// admin, each user reports to an admin. `reports_to` holds the manager's user id.
//
// A client's owner is still stored as a NAME string in client.assignedTeam,
// because that's what the UI has always written and 39 live client records use
// it. So visibility resolves to a set of assignee names rather than user ids.

const ROLES = {
  super_admin: { rank: 3, label: 'Super Admin' },
  admin:       { rank: 2, label: 'Admin' },
  user:        { rank: 1, label: 'User' }
};

// Roles that existed before this model, mapped forward. 'member' was the old
// non-admin role; the old 'admin' meant "everything", which is super_admin now —
// but only the seeded manager should be promoted that far, so callers that
// migrate data decide, not this function.
const LEGACY = { member: 'user', staff: 'user', 'team-lead': 'admin' };

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (ROLES[r]) return r;
  if (LEGACY[r]) return LEGACY[r];
  return 'user';   // unknown role gets the fewest privileges, never the most
}

function rankOf(role) { return (ROLES[normalizeRole(role)] || ROLES.user).rank; }
function labelOf(role) { return (ROLES[normalizeRole(role)] || ROLES.user).label; }

function isSuperAdmin(user) { return normalizeRole(user && user.role) === 'super_admin'; }
function isLead(user)       { return normalizeRole(user && user.role) === 'admin'; }
// "At least" comparisons, so a check reads as a floor rather than a list.
function atLeast(user, role) { return rankOf(user && user.role) >= rankOf(role); }

// Direct reports of a user.
function reportsOf(userId, allUsers) {
  return (allUsers || []).filter(u => u.reports_to != null && String(u.reports_to) === String(userId));
}

// The set of assignee names a user is allowed to see.
//
// Returns { all: true } for the super admin rather than enumerating everyone —
// a name-set would silently exclude clients assigned to somebody who has no
// login yet, and the manager must see those too.
function clientScope(user, allUsers) {
  if (!user) return { all: false, names: new Set() };
  if (isSuperAdmin(user)) return { all: true, names: null };

  const names = new Set();
  if (user.name) names.add(user.name);
  if (isLead(user)) {
    reportsOf(user.id, allUsers).forEach(u => { if (u.name) names.add(u.name); });
  }
  return { all: false, names };
}

function scopeAllows(scope, assignedTeam) {
  if (!scope) return false;
  if (scope.all) return true;
  return scope.names.has(assignedTeam);
}

// Filter a client list down to what this user may see.
function visibleClients(user, allUsers, clients) {
  const scope = clientScope(user, allUsers);
  if (scope.all) return clients || [];
  return (clients || []).filter(c => scopeAllows(scope, c.assignedTeam));
}

function visibleClientIds(user, allUsers, clients) {
  return visibleClients(user, allUsers, clients).map(c => String(c.id));
}

function canSeeClient(user, allUsers, client) {
  return !!client && scopeAllows(clientScope(user, allUsers), client.assignedTeam);
}

// Who should hear about a stuck job, in order. The escalation engine walks this
// so a problem climbs one rung at a time instead of going straight to the
// manager: the owner, then their lead, then the lead's manager.
function escalationChain(assigneeName, allUsers) {
  const chain = [];
  const owner = (allUsers || []).find(u => u.name === assigneeName && u.active !== 0);
  if (owner) {
    chain.push(owner);
    let cur = owner, hops = 0;
    while (cur && cur.reports_to != null && hops < 4) {
      const next = (allUsers || []).find(u => String(u.id) === String(cur.reports_to));
      if (!next || chain.some(c => String(c.id) === String(next.id))) break;
      chain.push(next);
      cur = next; hops++;
    }
  }
  // Always make sure a super admin is the last resort, even if the reporting
  // line is incomplete.
  if (!chain.some(u => isSuperAdmin(u))) {
    const top = (allUsers || []).find(u => isSuperAdmin(u) && u.active !== 0);
    if (top) chain.push(top);
  }
  return chain;
}

module.exports = {
  ROLES, normalizeRole, rankOf, labelOf,
  isSuperAdmin, isLead, atLeast,
  reportsOf, clientScope, scopeAllows,
  visibleClients, visibleClientIds, canSeeClient,
  escalationChain
};
