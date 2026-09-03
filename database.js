// In-memory cache backed by Supabase (write-through).
//
// Why the odd shape: every caller in the app (api.js, auth.js middleware, the
// 3 background engines) reads/writes this synchronously. Rewriting all of them
// to await Supabase is a ~60-site refactor with real regression risk. Instead
// we hydrate `store` from Supabase on boot and fire-and-forget writes back on
// every mutation. Sync read API preserved.
//
// Trade-off: two concurrent Lambda instances can briefly diverge on
// tracker_state (last-write-wins). Acceptable for internal <10-user tool.

const bcrypt = require('bcryptjs');
const { UsersDataRepo } = require('./repositories/usersRepo');
const { TrackerStateRepo } = require('./repositories/trackerStateRepo');
const { ActivityLogRepo } = require('./repositories/activityLogRepo');
const { isReady } = require('./aws');

const store = {
  users: [],
  trackerData: { clients: [], teamMembers: [] },
  activityLog: [],
  nextUserId: 1,
  hydrated: false
};

function fireAndForget(p, label) {
  Promise.resolve(p).catch(function(e) { console.warn('[db write-through ' + label + ']', e && e.message); });
}

async function hydrate() {
  if (!isReady()) {
    console.log('[db] AWS not configured — running fully in-memory (state will not persist)');
    return;
  }
  try {
    const [existingUsers, tracker, recentActivity] = await Promise.all([
      UsersDataRepo.listAll(),
      TrackerStateRepo.load(),
      ActivityLogRepo.listRecent(200)
    ]);
    store.users = existingUsers.map(function(u) {
      return {
        id: Number(u.id),
        email: u.email,
        password: u.password,
        name: u.name,
        role: u.role,
        // Who this person reports to. Visibility is derived from the reporting
        // line, so leaving it out of the hydration mapping stores it correctly
        // and then loses it on every boot — a team lead would silently see only
        // their own clients.
        reports_to: u.reports_to != null ? Number(u.reports_to) : null,
        active: u.active,
        invite_token: u.invite_token,
        invite_expires: u.invite_expires,
        created_at: u.created_at,
        last_login: u.last_login
      };
    });
    store.trackerData = { clients: tracker.clients, teamMembers: tracker.teamMembers };
    // Dynamo items don't carry the old integer id; derive one from position
    // (newest gets highest — matches how activity.log() assigned ids before).
    store.activityLog = recentActivity.map(function(r, i) {
      return {
        id: recentActivity.length - i,
        user_id: r.user_id,
        user_name: r.user_name,
        action: r.action,
        details: r.details || '',
        created_at: r.created_at
      };
    });
    store.nextUserId = store.users.reduce(function(m, u) { return u.id > m ? u.id : m; }, 0) + 1;
    store.hydrated = true;
    console.log('[db] hydrated from AWS: ' + store.users.length + ' user(s), '
      + store.trackerData.clients.length + ' client(s), '
      + store.activityLog.length + ' activity row(s)');
  } catch (e) {
    console.warn('[db] hydrate failed — continuing with empty store:', e.message);
  }
}

async function seedAdmin() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@tracker.com').toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin123!';
  const adminName = process.env.ADMIN_NAME || 'Admin';

  const existing = store.users.find(function(u) { return u.email === adminEmail; });
  if (existing) return;

  const row = {
    id: store.nextUserId++,
    email: adminEmail,
    password: bcrypt.hashSync(adminPass, 10),
    name: adminName,
    role: 'admin',
    active: 1,
    invite_token: null,
    invite_expires: null,
    created_at: new Date().toISOString(),
    last_login: null
  };
  store.users.push(row);
  await UsersDataRepo.upsert(row).catch(function(e) { console.warn('[db seedAdmin]', e.message); });
  console.log('Admin created:', adminEmail);
}

// Public boot entry. Callers may await this; server.js does so before listen.
async function initDatabase() {
  await hydrate();
  await seedAdmin();
  console.log('Database ready (cache + DynamoDB/S3 write-through)');
}

// ---------- users ----------
const users = {
  findByEmail(email) {
    return store.users.find(function(u) { return u.email === email && u.active === 1; }) || null;
  },
  findById(id) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return null;
    // reports_to must be part of every projection — visibility is derived from
    // the reporting line, so dropping it silently collapses a team lead's view
    // down to their own clients.
    return { id: u.id, email: u.email, name: u.name, role: u.role, reports_to: u.reports_to != null ? u.reports_to : null, active: u.active, created_at: u.created_at, last_login: u.last_login };
  },
  findByInviteToken(token) {
    return store.users.find(function(u) { return u.invite_token === token && new Date(u.invite_expires) > new Date(); }) || null;
  },
  getAll() {
    const roles = require('./roles');
    return store.users
      .map(function(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, reports_to: u.reports_to != null ? u.reports_to : null, active: u.active, created_at: u.created_at, last_login: u.last_login }; })
      // Seniority first, then alphabetical — so the manager, then leads, then
      // executives. The old sort only knew about a single 'admin' role.
      .sort(function(a, b) { return roles.rankOf(b.role) - roles.rankOf(a.role) || String(a.name || '').localeCompare(String(b.name || '')); });
  },

  // Change a person's role and/or who they report to, in one write. Used by the
  // admin panel — the two travel together, because a role change without a
  // reporting line leaves a lead with nobody under them.
  setRoleAndManager(id, role, reportsTo) {
    const roles = require('./roles');
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return null;
    const patch = {};
    if (role != null) { u.role = roles.normalizeRole(role); patch.role = u.role; }
    if (reportsTo !== undefined) {
      u.reports_to = (reportsTo === null || reportsTo === '') ? null : parseInt(reportsTo);
      patch.reports_to = u.reports_to;
    }
    if (Object.keys(patch).length) fireAndForget(UsersDataRepo.patch(u.id, patch), 'setRoleAndManager');
    return { id: u.id, email: u.email, name: u.name, role: u.role, reports_to: u.reports_to != null ? u.reports_to : null, active: u.active };
  },
  createInvite(email, name, token, expires) {
    const existing = store.users.find(function(u) { return u.email === email; });
    if (existing) {
      existing.invite_token = token;
      existing.invite_expires = expires;
      existing.name = name;
      existing.active = 0;
      fireAndForget(UsersDataRepo.patch(existing.id, { invite_token: token, invite_expires: expires, name: name, active: 0 }), 'createInvite/existing');
      return existing;
    }
    const user = {
      id: store.nextUserId++,
      email: email,
      password: bcrypt.hashSync(Math.random().toString(36), 10),
      name: name,
      // New people start as User — least privilege. Promote to Admin and set
      // their reporting line from the admin panel once they've signed up.
      // ('member' was the pre-hierarchy name for this and still normalises to
      // 'user', but new records shouldn't carry a retired key.)
      role: 'user',
      active: 0,
      invite_token: token,
      invite_expires: expires,
      created_at: new Date().toISOString(),
      last_login: null
    };
    store.users.push(user);
    fireAndForget(UsersDataRepo.upsert(user), 'createInvite/new');
    return user;
  },
  activateWithPassword(token, password) {
    const u = store.users.find(function(u) { return u.invite_token === token; });
    if (!u) return;
    u.password = bcrypt.hashSync(password, 10);
    u.active = 1;
    u.invite_token = null;
    u.invite_expires = null;
    fireAndForget(UsersDataRepo.patch(u.id, { password: u.password, active: 1, invite_token: null, invite_expires: null }), 'activateWithPassword');
  },
  updateLastLogin(id) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.last_login = new Date().toISOString();
    fireAndForget(UsersDataRepo.patch(u.id, { last_login: u.last_login }), 'updateLastLogin');
  },
  deactivate(id) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.active = 0;
    fireAndForget(UsersDataRepo.patch(u.id, { active: 0 }), 'deactivate');
  },
  activate(id) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.active = 1;
    fireAndForget(UsersDataRepo.patch(u.id, { active: 1 }), 'activate');
  },
  updateRole(id, role) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.role = role;
    fireAndForget(UsersDataRepo.patch(u.id, { role: role }), 'updateRole');
  },
  updatePassword(id, password) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.password = bcrypt.hashSync(password, 10);
    fireAndForget(UsersDataRepo.patch(u.id, { password: u.password }), 'updatePassword');
  },
  setResetToken(id, token, expires) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.invite_token = token;
    u.invite_expires = expires;
    fireAndForget(UsersDataRepo.patch(u.id, { invite_token: token, invite_expires: expires }), 'setResetToken');
  },
  clearResetToken(id) {
    const u = store.users.find(function(u) { return u.id === parseInt(id); });
    if (!u) return;
    u.invite_token = null;
    u.invite_expires = null;
    fireAndForget(UsersDataRepo.patch(u.id, { invite_token: null, invite_expires: null }), 'clearResetToken');
  },
  delete(id) {
    const nid = parseInt(id);
    store.users = store.users.filter(function(u) { return u.id !== nid; });
    fireAndForget(UsersDataRepo.remove(nid), 'delete');
  }
};

// ---------- tracker (clients + team) ----------
const tracker = {
  getData() { return { clients: store.trackerData.clients, teamMembers: store.trackerData.teamMembers }; },
  // Returns a Promise now so callers can await the S3 write and surface a
  // real error to the client. The in-memory update is still synchronous —
  // reads immediately after this call see the new data — but the promise
  // only resolves once tracker_state.json has actually been written to S3.
  //
  // Why: the previous fire-and-forget version returned {ok:true} the moment
  // it mutated in-memory state, before the S3 PUT completed. If the S3
  // write failed (throttle, perms, network), only a console.warn was
  // emitted; the frontend thought the save succeeded. On the next Lambda
  // cold start, hydrate() reloaded the OLD blob from S3 and the user's
  // import silently vanished. Awaiting it here means the PUT /api/tracker
  // handler can 500 on write failure and the UI can retry / alert.
  saveData(clients, teamMembers, updatedBy) {
    store.trackerData = { clients: clients, teamMembers: teamMembers, updatedAt: new Date().toISOString(), updatedBy: updatedBy };
    return TrackerStateRepo.save(clients, teamMembers, updatedBy);
  }
};

// ---------- activity log ----------
const activity = {
  log(userId, userName, action, details) {
    const entry = {
      id: store.activityLog.length + 1,
      user_id: userId,
      user_name: userName,
      action: action,
      details: details || '',
      created_at: new Date().toISOString()
    };
    store.activityLog.unshift(entry);
    if (store.activityLog.length > 200) store.activityLog = store.activityLog.slice(0, 200);
    fireAndForget(ActivityLogRepo.append(entry), 'activity.log');
  },
  getRecent(limit) { return store.activityLog.slice(0, limit || 50); }
};

module.exports = { initDatabase, users, tracker, activity, store };
