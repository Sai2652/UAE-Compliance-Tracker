const bcrypt = require('bcryptjs');

// In-memory storage — no filesystem writes needed
const store = {
  users: [],
  trackerData: { clients: [], teamMembers: [] },
  activityLog: [],
  nextUserId: 1
};

function initDatabase() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@tracker.com').toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin123!';
  const adminName = process.env.ADMIN_NAME || 'Admin';

  const existing = store.users.find(u => u.email === adminEmail);
  if (!existing) {
    store.users.push({
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
    });
    console.log('Admin created:', adminEmail);
  }
  console.log('Database ready (in-memory)');
}

const users = {
  findByEmail(email) {
    return store.users.find(u => u.email === email && u.active === 1) || null;
  },
  findById(id) {
    const u = store.users.find(u => u.id === parseInt(id));
    if (!u) return null;
    return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_at: u.created_at, last_login: u.last_login };
  },
  findByInviteToken(token) {
    return store.users.find(u => u.invite_token === token && new Date(u.invite_expires) > new Date()) || null;
  },
  getAll() {
    return store.users.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_at: u.created_at, last_login: u.last_login }))
      .sort((a, b) => (b.role === 'admin' ? 1 : 0) - (a.role === 'admin' ? 1 : 0) || a.name.localeCompare(b.name));
  },
  createInvite(email, name, token, expires) {
    const existing = store.users.find(u => u.email === email);
    if (existing) {
      existing.invite_token = token;
      existing.invite_expires = expires;
      existing.name = name;
      existing.active = 0;
      return existing;
    }
    const user = {
      id: store.nextUserId++,
      email, password: bcrypt.hashSync(Math.random().toString(36), 10),
      name, role: 'member', active: 0,
      invite_token: token, invite_expires: expires,
      created_at: new Date().toISOString(), last_login: null
    };
    store.users.push(user);
    return user;
  },
  activateWithPassword(token, password) {
    const u = store.users.find(u => u.invite_token === token);
    if (u) { u.password = bcrypt.hashSync(password, 10); u.active = 1; u.invite_token = null; u.invite_expires = null; }
  },
  updateLastLogin(id) {
    const u = store.users.find(u => u.id === parseInt(id));
    if (u) u.last_login = new Date().toISOString();
  },
  deactivate(id) { const u = store.users.find(u => u.id === parseInt(id)); if (u) u.active = 0; },
  activate(id) { const u = store.users.find(u => u.id === parseInt(id)); if (u) u.active = 1; },
  updateRole(id, role) { const u = store.users.find(u => u.id === parseInt(id)); if (u) u.role = role; },
  updatePassword(id, password) { const u = store.users.find(u => u.id === parseInt(id)); if (u) u.password = bcrypt.hashSync(password, 10); },
  setResetToken(id, token, expires) { const u = store.users.find(u => u.id === parseInt(id)); if (u) { u.invite_token = token; u.invite_expires = expires; } },
  clearResetToken(id) { const u = store.users.find(u => u.id === parseInt(id)); if (u) { u.invite_token = null; u.invite_expires = null; } },
  delete(id) { store.users = store.users.filter(u => u.id !== parseInt(id)); }
};

const tracker = {
  getData() { return { clients: store.trackerData.clients, teamMembers: store.trackerData.teamMembers }; },
  saveData(clients, teamMembers, updatedBy) { store.trackerData = { clients, teamMembers, updatedAt: new Date().toISOString(), updatedBy }; }
};

const activity = {
  log(userId, userName, action, details) {
    store.activityLog.unshift({ id: store.activityLog.length + 1, user_id: userId, user_name: userName, action, details: details || '', created_at: new Date().toISOString() });
    if (store.activityLog.length > 200) store.activityLog = store.activityLog.slice(0, 200);
  },
  getRecent(limit) { return store.activityLog.slice(0, limit || 50); }
};

module.exports = { initDatabase, users, tracker, activity, store };
