// Roles and visibility — the single place that decides who can see which client.
//
// Four roles, in decreasing power:
//
//   prime_admin  "Prime Admin"  firm-wide owner. Sees every Super Admin's
//                               downline. No scoping. Can invite any role.
//   super_admin  "Super Admin"  line-of-business owner. Sees their OWN
//                               downline (Admins they invited, those Admins'
//                               Users, and every client under any of them).
//                               Cannot see another Super Admin's downline.
//   admin        "Admin"        team owner. Sees their own team — Users
//                               reporting to them and those Users' clients.
//   user         "User"         executive. Sees only their own clients.
//
// The hierarchy walks `reports_to`: each user reports to an admin, each admin
// reports to a super admin, each super admin reports to a prime admin
// (or nobody, in the single-tenant case). visibility resolves by walking
// DOWN from the caller and collecting every name the caller is allowed
// to see clients for.
//
// A client's owner is still stored as a NAME string in client.assignedTeam,
// because that's what the UI has always written and existing client records
// use it. So visibility resolves to a set of assignee names rather than user
// ids — plus a firm-wide "all:true" pass for prime admin.

const ROLES = {
  prime_admin: { rank: 4, label: 'Prime Admin' },
  super_admin: { rank: 3, label: 'Super Admin' },
  admin:       { rank: 2, label: 'Admin' },
  user:        { rank: 1, label: 'User' }
};

// Roles that existed before this model, mapped forward. 'member' was the old
// non-admin role; the old 'admin' meant "everything", which is super_admin now
// (not prime_admin — the founder was added later, and only the manually seeded
// account should be promoted that far).
const LEGACY = { member: 'user', staff: 'user', 'team-lead': 'admin' };

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (ROLES[r]) return r;
  if (LEGACY[r]) return LEGACY[r];
  return 'user';   // unknown role gets the fewest privileges, never the most
}

function rankOf(role) { return (ROLES[normalizeRole(role)] || ROLES.user).rank; }
function labelOf(role) { return (ROLES[normalizeRole(role)] || ROLES.user).label; }

function isPrimeAdmin(user) { return normalizeRole(user && user.role) === 'prime_admin'; }
function isSuperAdmin(user) { return normalizeRole(user && user.role) === 'super_admin'; }
function isLead(user)       { return normalizeRole(user && user.role) === 'admin'; }
function atLeast(user, role) { return rankOf(user && user.role) >= rankOf(role); }

// Direct reports of a user.
function reportsOf(userId, allUsers) {
  return (allUsers || []).filter(u => u.reports_to != null && String(u.reports_to) === String(userId));
}

// Every user in this user's downline (all descendants, walking reports_to).
// Includes the root user themselves so the caller doesn't have to concat.
// Guards against cycles by tracking the visited set.
function downlineOf(user, allUsers) {
  const out = [];
  if (!user) return out;
  const visited = new Set();
  const stack = [user];
  while (stack.length) {
    const cur = stack.pop();
    const id = String(cur.id);
    if (visited.has(id)) continue;
    visited.add(id);
    out.push(cur);
    reportsOf(cur.id, allUsers).forEach(r => { if (!visited.has(String(r.id))) stack.push(r); });
  }
  return out;
}

// The set of assignee names a user is allowed to see clients for.
//
// Prime Admin returns { all: true } — sees every client without a name lookup,
// including those assigned to somebody who has no login yet.
//
// Super Admin returns names ONLY from their downline (was previously all:true,
// which showed another book's clients to a Super Admin who shouldn't see them).
//
// Admin returns own name + direct reports' names.
// User returns own name only.
function clientScope(user, allUsers) {
  if (!user) return { all: false, names: new Set() };
  if (isPrimeAdmin(user)) return { all: true, names: null };

  const names = new Set();
  if (user.name) names.add(user.name);

  if (isSuperAdmin(user) || isLead(user)) {
    downlineOf(user, allUsers).forEach(u => { if (u.name) names.add(u.name); });
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

// Who can invite whom. Matrix:
//   prime_admin -> any role
//   super_admin -> admin, user (only)
//   admin       -> user (only)
//   user        -> nobody
function canInvite(caller, targetRole) {
  const c = normalizeRole(caller && caller.role);
  const t = normalizeRole(targetRole);
  if (c === 'prime_admin') return true;
  if (c === 'super_admin') return t === 'admin' || t === 'user';
  if (c === 'admin')       return t === 'user';
  return false;
}

// Who should hear about a stuck job, in order. The escalation engine walks
// this so a problem climbs one rung at a time instead of going straight to
// the top: the owner, then their lead, then the super admin, and (last
// resort) a prime admin if one exists.
function escalationChain(assigneeName, allUsers) {
  const chain = [];
  const owner = (allUsers || []).find(u => u.name === assigneeName && u.active !== 0);
  if (owner) {
    chain.push(owner);
    let cur = owner, hops = 0;
    while (cur && cur.reports_to != null && hops < 5) {
      const next = (allUsers || []).find(u => String(u.id) === String(cur.reports_to));
      if (!next || chain.some(c => String(c.id) === String(next.id))) break;
      chain.push(next);
      cur = next; hops++;
    }
  }
  // Backstop 1: at least one super admin.
  if (!chain.some(u => isSuperAdmin(u))) {
    const top = (allUsers || []).find(u => isSuperAdmin(u) && u.active !== 0);
    if (top) chain.push(top);
  }
  // Backstop 2: a prime admin if one exists — the buck stops there.
  if (!chain.some(u => isPrimeAdmin(u))) {
    const prime = (allUsers || []).find(u => isPrimeAdmin(u) && u.active !== 0);
    if (prime) chain.push(prime);
  }
  return chain;
}

module.exports = {
  ROLES, normalizeRole, rankOf, labelOf,
  isPrimeAdmin, isSuperAdmin, isLead, atLeast,
  reportsOf, downlineOf, clientScope, scopeAllows,
  visibleClients, visibleClientIds, canSeeClient,
  canInvite,
  escalationChain
};
