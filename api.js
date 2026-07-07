const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { users, tracker, activity } = require('./database');
const { generateToken, requireAuth, requireAdmin } = require('./auth');
const { sendInviteEmail, sendResetEmail } = require('./email');
const compliance = require('./compliance');
const taskEngine = require('./taskEngine');
const { obligations } = require('./obligations');
const obligationEngine = require('./obligationEngine');
const healthScore = require('./healthScore');
const slaMonitor = require('./slaMonitor');
const escalationEngine = require('./escalationEngine');
const repos = require('./repositories');
const capacityService = require('./services/capacityService');
const productivityService = require('./services/productivityService');
const forecastService = require('./services/forecastService');
const reviewQueueService = require('./services/reviewQueueService');
const communicationService = require('./services/communicationService');
const kpiService = require('./services/kpiService');
const commandCenterService = require('./services/commandCenterService');
const workflowService = require('./services/workflowService');
const readinessService = require('./services/readinessService');
const riskService = require('./services/riskService');
const bottleneckService = require('./services/bottleneckService');
const actionCenterService = require('./services/actionCenterService');
const briefingService = require('./services/briefingService');
const followUpService = require('./services/followUpService');
const router = express.Router();

router.post('/auth/login', function(req, res) {
  var email = req.body.email; var password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  var user = users.findByEmail(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid email or password' });
  users.updateLastLogin(user.id);
  activity.log(user.id, user.name, 'login');
  var token = generateToken(user);
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ token: token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post('/auth/logout', function(req, res) { res.clearCookie('token'); res.json({ ok: true }); });

router.get('/auth/me', requireAuth, function(req, res) {
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role } });
});

router.post('/auth/forgot-password', async function(req, res) {
  var email = req.body.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  var user = users.findByEmail(email.toLowerCase().trim());
  if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });
  var token = crypto.randomBytes(32).toString('hex');
  var expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  users.setResetToken(user.id, token, expires);
  var resetUrl = (process.env.APP_URL || 'http://localhost:3000') + '/reset-password?token=' + token;
  var result = await sendResetEmail(user.email, user.name, resetUrl);
  if (result.success) { res.json({ message: 'Password reset link sent to your email.' }); }
  else { res.json({ message: 'Email failed. Use this link:', resetUrl: resetUrl }); }
});

router.get('/auth/reset-password/verify/:token', function(req, res) {
  var user = users.findByInviteToken(req.params.token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  res.json({ email: user.email, name: user.name });
});

router.post('/auth/reset-password', function(req, res) {
  var token = req.body.token; var password = req.body.password;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  var user = users.findByInviteToken(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
  users.updatePassword(user.id, password);
  users.clearResetToken(user.id);
  activity.log(user.id, user.name, 'password_reset');
  res.json({ ok: true });
});

router.post('/invite', requireAuth, requireAdmin, async function(req, res) {
  var email = req.body.email; var name = req.body.name;
  if (!email || !name) return res.status(400).json({ error: 'Email and name required' });
  var cleanEmail = email.toLowerCase().trim();
  var existing = users.findByEmail(cleanEmail);
  if (existing && existing.active) return res.status(400).json({ error: 'User already exists and is active' });
  var token = crypto.randomBytes(32).toString('hex');
  var expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  users.createInvite(cleanEmail, name, token, expires);
  var inviteUrl = (process.env.APP_URL || 'http://localhost:3000') + '/signup?token=' + token;
  var result = await sendInviteEmail(cleanEmail, name, inviteUrl);
  if (result.success) {
    activity.log(req.user.id, req.user.name, 'invite_sent', 'Invited ' + name);
    res.json({ ok: true, message: 'Invite sent to ' + cleanEmail });
  } else {
    res.json({ ok: true, inviteUrl: inviteUrl, message: 'Email failed (' + result.error + '). Share this link manually:', manualLink: inviteUrl });
  }
});

router.get('/invite/verify/:token', function(req, res) {
  var user = users.findByInviteToken(req.params.token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired invite link' });
  res.json({ email: user.email, name: user.name });
});

router.post('/invite/signup', function(req, res) {
  var token = req.body.token; var password = req.body.password; var name = req.body.name;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  var user = users.findByInviteToken(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired invite link' });
  users.activateWithPassword(token, password);
  if (name) { var u = require('./database').store.users.find(function(u) { return u.invite_token === null && u.email === user.email; }); if (u) u.name = name; }
  activity.log(user.id, name || user.name, 'signup');
  var updatedUser = users.findById(user.id);
  var authToken = generateToken(updatedUser);
  res.cookie('token', authToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ token: authToken, user: { id: updatedUser.id, email: updatedUser.email, name: updatedUser.name, role: updatedUser.role } });
});

router.get('/users', requireAuth, requireAdmin, function(req, res) { res.json({ users: users.getAll() }); });
router.put('/users/:id/role', requireAuth, requireAdmin, function(req, res) { users.updateRole(req.params.id, req.body.role); res.json({ ok: true }); });
router.put('/users/:id/deactivate', requireAuth, requireAdmin, function(req, res) { users.deactivate(req.params.id); res.json({ ok: true }); });
router.put('/users/:id/activate', requireAuth, requireAdmin, function(req, res) { users.activate(req.params.id); res.json({ ok: true }); });
router.delete('/users/:id', requireAuth, requireAdmin, function(req, res) {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  users.delete(req.params.id); res.json({ ok: true });
});
router.put('/users/:id/reset-password', requireAuth, requireAdmin, function(req, res) {
  if (!req.body.password || req.body.password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  users.updatePassword(req.params.id, req.body.password); res.json({ ok: true });
});

// Fields on a client whose change should trigger obligation regeneration.
var COMPLIANCE_FIELDS = ['vatRegistrationDate','vatFrequency','vatCertificate','ctRegistrationDate','financialYearEnd','incorporationDate','ctCertificate','assignedTeam'];
function complianceFingerprint(c) { if (!c) return ''; return COMPLIANCE_FIELDS.map(function(k){ return k + '=' + (c[k] == null ? '' : c[k]); }).join('|'); }

router.get('/tracker', requireAuth, function(req, res) { res.json(tracker.getData()); });
router.put('/tracker', requireAuth, function(req, res) {
  var clients = req.body.clients; var teamMembers = req.body.teamMembers; var user = req.user;
  var existing = tracker.getData();
  if (user.role === 'member') {
    var merged = existing.clients.map(function(ec) { 
      var updated = clients.find(function(c) { return c.id === ec.id; }); 
      if (updated && ec.assignedTeam === user.name) {
        // Log specific changes
        if (JSON.stringify(ec) !== JSON.stringify(updated)) {
          activity.log(user.id, user.name, 'client_updated', 'Updated: ' + ec.name);
        }
        return updated; 
      }
      return ec; 
    });
    tracker.saveData(merged, existing.teamMembers, user.name);
    activity.log(user.id, user.name, 'data_save', 'Member saved assigned clients');
  } else {
    // Log new/removed clients
    var newClients = (clients || []).filter(function(c) { return !existing.clients.find(function(ec) { return ec.id === c.id; }); });
    var removedClients = existing.clients.filter(function(ec) { return !(clients || []).find(function(c) { return c.id === ec.id; }); });
    newClients.forEach(function(c) { activity.log(user.id, user.name, 'client_added', c.name); });
    removedClients.forEach(function(c) { activity.log(user.id, user.name, 'client_removed', c.name); });
    // Log modified clients
    (clients || []).forEach(function(c) {
      var old = existing.clients.find(function(ec) { return ec.id === c.id; });
      if (old && JSON.stringify(old) !== JSON.stringify(c)) {
        activity.log(user.id, user.name, 'client_updated', c.name);
      }
    });
    tracker.saveData(clients || [], teamMembers || [], user.name);
  }
  // Phase 2: regenerate obligations for any client whose compliance settings changed.
  try {
    var after = tracker.getData().clients || [];
    var changed = [];
    after.forEach(function(c){
      var prev = existing.clients.find(function(e){ return e.id === c.id; });
      if (!prev || complianceFingerprint(prev) !== complianceFingerprint(c)) changed.push(c.id);
    });
    if (changed.length) {
      changed.forEach(function(id){
        obligationEngine.regenerateForClient(id).catch(function(e){ console.error('[obligationEngine] regen', id, e.message); });
      });
    }
  } catch (e) { console.error('[obligationEngine] hook error:', e.message); }
  res.json({ ok: true });
});

router.get('/activity', requireAuth, function(req, res) { 
  var all = activity.getRecent(parseInt(req.query.limit) || 50);
  if (req.user.role !== 'admin') {
    all = all.filter(function(a) { return a.user_id === req.user.id; });
  }
  res.json({ activities: all }); 
});

// =====================================================================
// Task Engine — tasks, comments, documents, dashboards
// =====================================================================

function asyncH(fn) { return function(req, res) { fn(req, res).catch(function(e){ console.error(e); res.status(500).json({ error: e.message || 'Server error' }); }); }; }

// ---- Tasks ----
router.get('/tasks', requireAuth, asyncH(async function(req, res) {
  var filter = {};
  if (req.query.mine === '1') filter.assignedUserId = req.user.id;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.status) filter.status = req.query.status.split(',');
  if (req.query.overdue === '1') filter.overdue = true;
  // members only see their own tasks
  if (req.user.role !== 'admin') filter.assignedUserId = req.user.id;
  var rows = await compliance.tasks.list(filter);
  res.json({ tasks: rows });
}));

router.post('/tasks', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var b = req.body || {};
  if (!b.clientId || !b.taskType) return res.status(400).json({ error: 'clientId and taskType required' });
  var client = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(b.clientId); });
  if (!client) return res.status(400).json({ error: 'Unknown client' });
  var task = await compliance.tasks.create({
    clientId: client.id, clientName: client.name,
    taskType: b.taskType, title: b.title, description: b.description,
    assignedUserId: b.assignedUserId || null, assignedUserName: b.assignedUserName || null,
    dueDate: b.dueDate || null, complianceDeadline: b.complianceDeadline || null,
    status: b.status || 'not_started', createdBy: req.user.id
  });
  activity.log(req.user.id, req.user.name, 'task_created', task.task_type + ' for ' + client.name);
  res.json({ task: task });
}));

router.get('/tasks/:id', requireAuth, asyncH(async function(req, res) {
  var t = await compliance.tasks.getById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && t.assigned_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  var comments = await compliance.comments.listForTask(t.id);
  res.json({ task: t, comments: comments });
}));

router.patch('/tasks/:id', requireAuth, asyncH(async function(req, res) {
  var t = await compliance.tasks.getById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  var isOwner = t.assigned_user_id === req.user.id;
  var isAdmin = req.user.role === 'admin';
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });
  var patch = {};
  var allowedMember = ['status','description'];
  var allowedAdmin = allowedMember.concat(['assigned_user_id','assigned_user_name','due_date','compliance_deadline','priority_score','task_type','title']);
  var allowed = isAdmin ? allowedAdmin : allowedMember;
  Object.keys(req.body || {}).forEach(function(k){ if (allowed.indexOf(k) >= 0) patch[k] = req.body[k]; });

  // Review workflow guard: members cannot self-complete or escalate.
  if (patch.status) {
    var restricted = ['reviewed','completed','escalated'];
    if (!isAdmin && restricted.indexOf(patch.status) >= 0) {
      return res.status(403).json({ error: 'Only admins can move tasks to ' + patch.status });
    }
    if (!isAdmin && patch.status === 'ready_for_review' && t.status !== 'in_progress' && t.status !== 'documents_received') {
      return res.status(400).json({ error: 'Can only submit for review from in_progress or documents_received' });
    }
    if (patch.status === 'ready_for_review') patch.review_status = 'pending_review';
    if (patch.status === 'reviewed') patch.review_status = 'approved';
  }
  var updated = await compliance.tasks.update(t.id, patch);
  if (patch.status && patch.status !== t.status) {
    activity.log(req.user.id, req.user.name, 'task_status', t.id + ': ' + t.status + ' → ' + patch.status);
    // re-score lazily
    taskEngine.recomputeAllPriorities().catch(function(){});
  }
  res.json({ task: updated });
}));

router.post('/tasks/:id/submit-review', requireAuth, asyncH(async function(req, res) {
  var t = await compliance.tasks.getById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && t.assigned_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (t.status !== 'in_progress' && t.status !== 'documents_received') return res.status(400).json({ error: 'Task must be in_progress' });
  var nowIso = new Date().toISOString();
  var updated = await compliance.tasks.setStatus(t.id, 'ready_for_review', { review_status: 'pending_review', submitted_for_review_at: nowIso });
  activity.log(req.user.id, req.user.name, 'task_submitted_review', String(t.id));
  res.json({ task: updated });
}));

router.post('/tasks/:id/review', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var t = await compliance.tasks.getById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  var decision = req.body && req.body.decision;
  if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: 'decision must be approve|reject' });
  if (t.status !== 'ready_for_review') return res.status(400).json({ error: 'Task is not awaiting review' });
  var patch;
  if (decision === 'approve') patch = { status: 'reviewed', review_status: 'approved', reviewer_user_id: req.user.id };
  else patch = { status: 'in_progress', review_status: 'rejected', reviewer_user_id: req.user.id };
  var updated = await compliance.tasks.update(t.id, patch);
  // Phase 3: append immutable review event (acceptance rate + turnaround analytics).
  try {
    var submittedAt = t.submitted_for_review_at || t.last_status_change;
    var turnaround = submittedAt ? Math.round((Date.now() - new Date(submittedAt).getTime()) / 1000) : null;
    await repos.ReviewEventsRepo.create({
      taskId: t.id, submittedAt: submittedAt, reviewerUserId: req.user.id,
      reviewerUserName: req.user.name, decision: decision, turnaroundSeconds: turnaround,
      notes: req.body && req.body.notes || null
    });
  } catch (e) { console.error('[review_event]', e.message); }
  activity.log(req.user.id, req.user.name, 'task_reviewed', t.id + ': ' + decision);
  res.json({ task: updated });
}));

router.post('/tasks/:id/complete', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var t = await compliance.tasks.getById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'reviewed') return res.status(400).json({ error: 'Task must be reviewed before completion' });
  var updated = await compliance.tasks.setStatus(t.id, 'completed');
  activity.log(req.user.id, req.user.name, 'task_completed', String(t.id));
  res.json({ task: updated });
}));

router.get('/tasks/:id/comments', requireAuth, asyncH(async function(req, res) {
  res.json({ comments: await compliance.comments.listForTask(req.params.id) });
}));
router.post('/tasks/:id/comments', requireAuth, asyncH(async function(req, res) {
  var body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  var c = await compliance.comments.add(req.params.id, req.user.id, req.user.name, body);
  res.json({ comment: c });
}));

// ---- My Next Priority Work ----
router.get('/my/priority-queue', requireAuth, asyncH(async function(req, res) {
  var rows = await compliance.tasks.list({
    assignedUserId: req.user.id,
    notStatus: ['completed'],
    orderBy: 'priority_score',
    limit: 100
  });
  res.json({ tasks: rows });
}));

// ---- Manager dashboard (admin) ----
router.get('/manager/dashboard', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var todayStr = new Date().toISOString().slice(0,10);
  var weekStr = new Date(Date.now() + 7*24*60*60*1000).toISOString().slice(0,10);

  var [overdue, dueToday, upcoming, blocked, awaitingReview, allOpen] = await Promise.all([
    compliance.tasks.list({ overdue: true, limit: 200 }),
    compliance.tasks.list({ dueBefore: todayStr, notStatus: ['completed'], limit: 200 }),
    compliance.tasks.list({ dueBefore: weekStr, notStatus: ['completed'], limit: 200 }),
    compliance.tasks.list({ status: ['blocked','escalated'], limit: 200 }),
    compliance.tasks.list({ status: 'ready_for_review', limit: 200 }),
    compliance.tasks.list({ notStatus: ['completed'], limit: 1000 })
  ]);

  // Workload summary: count open tasks per assignee
  var workload = {};
  allOpen.forEach(function(t){
    var key = t.assigned_user_name || 'Unassigned';
    workload[key] = (workload[key] || 0) + 1;
  });

  var pendingDocs = await compliance.documents.list({ status: 'pending', limit: 500 });

  res.json({
    criticalToday: dueToday.slice(0, 50),
    upcomingDeadlines: upcoming.slice(0, 50),
    overdue: overdue.slice(0, 50),
    blocked: blocked.slice(0, 50),
    awaitingReview: awaitingReview.slice(0, 50),
    workload: Object.keys(workload).map(function(k){ return { user: k, openTasks: workload[k] }; }).sort(function(a,b){ return b.openTasks - a.openTasks; }),
    pendingDocuments: pendingDocs.slice(0, 50)
  });
}));

// ---- Documents ----
router.get('/documents', requireAuth, asyncH(async function(req, res) {
  var filter = { status: req.query.status || 'pending' };
  if (req.query.clientId) filter.clientId = req.query.clientId;
  var rows = await compliance.documents.list(filter);
  // members only see docs for clients they own
  if (req.user.role !== 'admin') {
    var myClients = (tracker.getData().clients || []).filter(function(c){ return c.assignedTeam === req.user.name; }).map(function(c){ return String(c.id); });
    rows = rows.filter(function(r){ return myClients.indexOf(String(r.client_external_id)) >= 0; });
  }
  res.json({ documents: rows });
}));

router.post('/documents', requireAuth, asyncH(async function(req, res) {
  var b = req.body || {};
  if (!b.clientId || !b.documentName) return res.status(400).json({ error: 'clientId and documentName required' });
  var client = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(b.clientId); });
  if (!client) return res.status(400).json({ error: 'Unknown client' });
  var doc = await compliance.documents.create({
    clientId: client.id, clientName: client.name,
    documentName: b.documentName, notes: b.notes, taskId: b.taskId || null,
    requestedById: req.user.id, requestedByName: req.user.name
  });
  activity.log(req.user.id, req.user.name, 'document_requested', b.documentName + ' from ' + client.name);
  res.json({ document: doc });
}));

router.post('/documents/:id/remind', requireAuth, asyncH(async function(req, res) {
  var d = await compliance.documents.remind(req.params.id);
  activity.log(req.user.id, req.user.name, 'document_reminder', String(req.params.id));
  res.json({ document: d });
}));

router.post('/documents/:id/receive', requireAuth, asyncH(async function(req, res) {
  var d = await compliance.documents.markReceived(req.params.id);
  activity.log(req.user.id, req.user.name, 'document_received', String(req.params.id));
  res.json({ document: d });
}));

// ---- Priority config (admin) ----
router.get('/priority-config', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ config: await compliance.config.getAll() });
}));
router.put('/priority-config', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var updates = req.body && req.body.config || {};
  for (var k in updates) await compliance.config.set(k, Number(updates[k]));
  await taskEngine.recomputeAllPriorities();
  res.json({ ok: true, config: await compliance.config.getAll() });
}));

// ---- Generation sweep (admin trigger) ----
router.post('/tasks/generate', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var result = await taskEngine.runGenerationSweep();
  res.json(result);
}));

// =====================================================================
// PHASE 2 — Intelligence, Calendar, Health, SLA, Escalation, Exceptions
// =====================================================================

// ---- Obligations ----
router.get('/obligations', requireAuth, asyncH(async function(req, res) {
  var f = {};
  if (req.query.clientId) f.clientId = req.query.clientId;
  if (req.query.type)     f.type = req.query.type.split(',');
  if (req.query.status)   f.status = req.query.status.split(',');
  if (req.query.from)     f.from = req.query.from;
  if (req.query.to)       f.to = req.query.to;
  var rows = await obligations.list(f);
  // members: limit to their assigned clients
  if (req.user.role !== 'admin') {
    var myClients = (tracker.getData().clients || []).filter(function(c){ return c.assignedTeam === req.user.name; }).map(function(c){ return String(c.id); });
    rows = rows.filter(function(r){ return myClients.indexOf(String(r.client_external_id)) >= 0; });
  }
  res.json({ obligations: rows });
}));

router.post('/obligations/refresh', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var clientId = req.body && req.body.clientId;
  if (clientId) {
    var r = await obligationEngine.regenerateForClient(clientId);
    return res.json(r);
  }
  res.json(await obligationEngine.runFullSweep());
}));

router.patch('/obligations/:id', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var b = req.body || {};
  if (b.status === 'filed') return res.json({ obligation: await obligations.setStatus(req.params.id, 'filed') });
  if (b.status === 'waived') return res.json({ obligation: await obligations.setStatus(req.params.id, 'waived') });
  res.status(400).json({ error: 'status must be filed|waived' });
}));

// ---- Calendar ----
router.get('/calendar', requireAuth, asyncH(async function(req, res) {
  var from = req.query.from || new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
  var to   = req.query.to   || new Date(Date.now() + 90*24*60*60*1000).toISOString().slice(0,10);
  var oFilter = { from: from, to: to };
  if (req.query.clientId) oFilter.clientId = req.query.clientId;
  if (req.query.types) oFilter.type = req.query.types.split(',');
  var oblRows = await obligations.list(oFilter);

  var tFilter = { dueBefore: to, limit: 2000 };
  if (req.query.clientId) tFilter.clientId = req.query.clientId;
  var taskRows = await compliance.tasks.list(tFilter);
  // Drop tasks whose due_date is before `from`
  taskRows = taskRows.filter(function(t){ return t.due_date && t.due_date >= from; });

  if (req.user.role !== 'admin') {
    var myClients = (tracker.getData().clients || []).filter(function(c){ return c.assignedTeam === req.user.name; }).map(function(c){ return String(c.id); });
    oblRows = oblRows.filter(function(r){ return myClients.indexOf(String(r.client_external_id)) >= 0; });
    taskRows = taskRows.filter(function(t){ return t.assigned_user_id === req.user.id || myClients.indexOf(String(t.client_external_id)) >= 0; });
  }
  if (req.query.userId) {
    taskRows = taskRows.filter(function(t){ return String(t.assigned_user_id) === String(req.query.userId); });
  }

  var events = [];
  oblRows.forEach(function(o){
    events.push({ kind: 'obligation', date: o.filing_deadline, type: o.obligation_type, title: o.obligation_type.replace(/_/g,' ') + ' ' + o.period_label, client: o.client_name, id: o.id, status: o.status });
  });
  taskRows.forEach(function(t){
    events.push({ kind: 'task', date: t.due_date, type: t.task_type, title: t.title || t.task_type.replace(/_/g,' '), client: t.client_name, id: t.id, status: t.status, sla_status: t.sla_status, priority: t.priority_score, owner: t.assigned_user_name });
  });
  events.sort(function(a,b){ return (a.date || '').localeCompare(b.date || ''); });
  res.json({ from: from, to: to, events: events });
}));

// ---- Health ----
router.get('/clients/:id/health', requireAuth, asyncH(async function(req, res) {
  var client = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id); });
  if (!client) return res.status(404).json({ error: 'Unknown client' });
  if (req.user.role !== 'admin' && client.assignedTeam !== req.user.name) return res.status(403).json({ error: 'Forbidden' });
  res.json({ health: await healthScore.computeForClient(client) });
}));

router.get('/health/summary', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var rows = await healthScore.computeForAll(tracker.getData().clients || []);
  res.json({ scores: rows, weights: await healthScore.getWeights() });
}));

router.get('/health/weights', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ weights: await healthScore.getWeights() });
}));
router.put('/health/weights', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var updates = req.body && req.body.weights || {};
  for (var k in updates) {
    await repos.HealthWeightsRepo.set(k, Number(updates[k]));
  }
  res.json({ weights: await healthScore.getWeights() });
}));

// ---- SLA ----
router.get('/sla/policies', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ policies: await slaMonitor.getPolicies() });
}));
router.put('/sla/policies', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var updates = req.body && req.body.policies || {};
  for (var taskType in updates) {
    await repos.SlaPoliciesRepo.upsert(taskType, updates[taskType]);
  }
  await slaMonitor.recomputeAll();
  res.json({ policies: await slaMonitor.getPolicies() });
}));
router.post('/sla/recompute', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await slaMonitor.recomputeAll());
}));

// ---- Escalation ----
router.get('/escalation/rules', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ rules: await repos.EscalationRulesRepo.listAll() });
}));
router.put('/escalation/rules/:id', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var allowed = ['name','condition_type','threshold_days','severity','notify_owner','notify_admin','active'];
  var patch = {};
  Object.keys(req.body || {}).forEach(function(k){ if (allowed.indexOf(k) >= 0) patch[k] = req.body[k]; });
  var rule = await repos.EscalationRulesRepo.update(req.params.id, patch);
  res.json({ rule: rule });
}));
router.post('/escalation/run', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await escalationEngine.runSweep());
}));
router.get('/escalation/events', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ events: await repos.EscalationEventsRepo.listRecent(parseInt(req.query.limit) || 100) });
}));

// ---- Exceptions Dashboard ----
router.get('/exceptions', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var [overdue, blocked, escalated, allOpen] = await Promise.all([
    compliance.tasks.list({ overdue: true, limit: 500 }),
    compliance.tasks.list({ status: 'blocked', limit: 500 }),
    compliance.tasks.list({ status: 'escalated', limit: 500 }),
    compliance.tasks.list({ notStatus: ['completed'], limit: 5000 })
  ]);
  var docsStale = (await compliance.documents.list({ status: 'pending', limit: 1000 })).filter(function(d){
    return (Date.now() - new Date(d.requested_date).getTime()) > 7*24*60*60*1000;
  });
  var health = await healthScore.computeForAll(tracker.getData().clients || []);
  var atRiskClients = health.filter(function(h){ return h.band === 'at_risk' || h.band === 'critical'; });
  res.json({
    overdue: overdue,
    blocked: blocked,
    escalated: escalated,
    missingDocuments: docsStale,
    highRiskClients: atRiskClients,
    totalOpenTasks: allOpen.length
  });
}));

// =====================================================================
// PHASE 3 — Operations Management (capacity, workload, productivity,
// forecasting, command center, reviews, communication, KPIs).
// Thin handlers — all business logic lives in services/*.
// =====================================================================

router.get('/team/capacity', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await capacityService.getCapacityDashboard());
}));

router.get('/team/workload', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await capacityService.getCapacityDashboard()); // same payload, alias for clarity
}));

router.get('/team/workload/recommendations', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await capacityService.getWorkloadRecommendations(parseInt(req.query.max) || 8));
}));

router.post('/team/workload/recommendations/apply', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var rec = req.body && req.body.recommendation || {};
  if (!rec.toUserId || !Array.isArray(rec.taskIds)) return res.status(400).json({ error: 'toUserId and taskIds required' });
  var targetUser = repos.UsersRepo.findById(rec.toUserId);
  if (!targetUser) return res.status(400).json({ error: 'Unknown target user' });
  var updated = [];
  for (var i = 0; i < rec.taskIds.length; i++) {
    var t = await compliance.tasks.update(rec.taskIds[i], { assigned_user_id: targetUser.id, assigned_user_name: targetUser.name });
    updated.push(t.id);
  }
  activity.log(req.user.id, req.user.name, 'workload_rebalance', 'Reassigned ' + updated.length + ' task(s) to ' + targetUser.name);
  res.json({ reassigned: updated.length, taskIds: updated });
}));

router.get('/team/productivity', requireAuth, asyncH(async function(req, res) {
  var range = req.query.range || '30';
  if (req.query.userId) {
    var uid = parseInt(req.query.userId, 10);
    if (req.user.role !== 'admin' && uid !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    return res.json({ user: await productivityService.getForUser(uid, range) });
  }
  if (req.user.role !== 'admin') {
    return res.json({ user: await productivityService.getForUser(req.user.id, range) });
  }
  res.json({ users: await productivityService.getForAll(range) });
}));

router.get('/team/kpis', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await kpiService.getKpis(req.query.range || '30'));
}));

router.get('/forecast', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await forecastService.getForecast(req.query.days || 30));
}));

router.get('/ops/command-center', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await commandCenterService.getCommandCenter());
}));

router.get('/review-queue', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await reviewQueueService.getQueue());
}));

router.get('/clients/communication', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await communicationService.getCommunicationBoard());
}));

// Workload config (capacity defaults + band thresholds)
router.get('/team/workload-config', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ config: await repos.WorkloadConfigRepo.getAll() });
}));
router.put('/team/workload-config', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var updates = req.body && req.body.config || {};
  for (var k in updates) await repos.WorkloadConfigRepo.set(k, Number(updates[k]));
  res.json({ config: await repos.WorkloadConfigRepo.getAll() });
}));

// Per-user capacity overrides
router.get('/team/capacity-overrides', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ overrides: await repos.UserCapacityRepo.getAll() });
}));
router.put('/team/capacity/:userId', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var uid = parseInt(req.params.userId, 10);
  var u = repos.UsersRepo.findById(uid);
  if (!u) return res.status(404).json({ error: 'User not found' });
  var payload = { user_name: u.name };
  if (req.body && req.body.capacity_open_tasks != null) payload.capacity_open_tasks = parseInt(req.body.capacity_open_tasks, 10);
  if (req.body && req.body.capacity_weekly_completions != null) payload.capacity_weekly_completions = parseInt(req.body.capacity_weekly_completions, 10);
  if (req.body && req.body.notes != null) payload.notes = req.body.notes;
  res.json({ override: await repos.UserCapacityRepo.setForUser(uid, payload) });
}));

// =====================================================================
// PHASE 4 (minimal) — Workflows + Readiness
// =====================================================================
router.get('/clients/readiness', requireAuth, asyncH(async function(req, res) {
  var clientReadinessService = require('./services/clientReadinessService');
  var data = await clientReadinessService.getAllClientReadiness();
  if (req.user.role !== 'admin') {
    var myClients = (tracker.getData().clients || []).filter(function(c){ return c.assignedTeam === req.user.name; }).map(function(c){ return String(c.id); });
    data.clients = data.clients.filter(function(r){ return myClients.indexOf(String(r.clientId)) >= 0; });
    var counts = {}; Object.keys(data.counts).forEach(function(k){ counts[k] = 0; });
    data.clients.forEach(function(r){ counts[r.state] = (counts[r.state] || 0) + 1; });
    data.counts = counts;
  }
  res.json(data);
}));

router.get('/clients/:id/lifecycle-summary', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  var clientLifecycleService = require('./services/clientLifecycleService');
  var data = await clientLifecycleService.getLifecycleSummary(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown client' });
  res.json(data);
}));

router.get('/clients/:id/workflows', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  var rows = await workflowService.listForClient(req.params.id);
  res.json({ workflows: rows });
}));

router.get('/workflows', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var filter = {};
  if (req.query.type)   filter.workflowType = req.query.type.split(',');
  if (req.query.status) filter.status = req.query.status.split(',');
  res.json({ workflows: await workflowService.listAll(filter) });
}));

router.get('/workflows/:id', requireAuth, asyncH(async function(req, res) {
  var data = await workflowService.getWorkflow(req.params.id);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
}));

router.post('/workflows/:id/advance', requireAuth, asyncH(async function(req, res) {
  var b = req.body || {};
  try {
    var data = await workflowService.advanceStep({
      workflowId: req.params.id,
      requireKey: b.requireKey || null,
      userId: req.user.id, userName: req.user.name,
      notes: b.notes || null,
      isAdmin: req.user.role === 'admin',
      forceStepKey: b.forceStepKey || null
    });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.get('/workflows/:id/readiness', requireAuth, asyncH(async function(req, res) {
  res.json({ readiness: await readinessService.assessWorkflow(req.params.id) });
}));

router.get('/readiness/filings', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ readiness: await readinessService.assessAllFilings() });
}));

// =====================================================================
// PHASE 5 — Risk Center
// =====================================================================
router.get('/risk/findings', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var data = await riskService.runAll();
  var findings = data.findings;
  if (req.query.level)    findings = findings.filter(f => f.level === req.query.level);
  if (req.query.clientId) findings = findings.filter(f => String(f.clientId) === String(req.query.clientId));
  if (req.query.userId)   findings = findings.filter(f => String(f.userId) === String(req.query.userId));
  if (req.query.kind)     findings = findings.filter(f => f.kind === req.query.kind);
  var grouped = null;
  if (req.query.groupBy) grouped = riskService.groupBy(findings, req.query.groupBy);
  res.json({ findings: findings, grouped: grouped, totals: data.totals });
}));

router.get('/risk/clients', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var data = await riskService.runAll();
  res.json({ scores: riskService.computeClientScores(data.findings, data.config, repos.ClientsRepo.listAll()) });
}));

router.get('/risk/clients/:id', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  var data = await riskService.runAll();
  var scores = riskService.computeClientScores(data.findings, data.config, repos.ClientsRepo.listAll());
  var row = scores.find(s => String(s.clientId) === String(req.params.id)) || null;
  var findings = data.findings.filter(f => String(f.clientId) === String(req.params.id));
  res.json({ score: row, findings: findings });
}));

router.get('/risk/team-accountability', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var [data, cap, prod] = await Promise.all([
    riskService.runAll(),
    require('./services/capacityService').getCapacityDashboard(),
    require('./services/productivityService').getForAll('30')
  ]);
  var byUser = {};
  data.findings.forEach(f => {
    if (f.userId == null) return;
    var k = String(f.userId);
    byUser[k] = byUser[k] || { userId: f.userId, userName: f.userName, critical:0, high:0, medium:0, low:0 };
    byUser[k][f.level]++;
  });
  var rows = (cap.rows || []).filter(r => r.userId).map(r => {
    var f = byUser[String(r.userId)] || { critical:0, high:0, medium:0, low:0 };
    var p = (prod || []).find(x => x.userId === r.userId) || {};
    return {
      userId: r.userId, userName: r.userName,
      tasksOverdue: r.overdueTasks, reviewsPending: r.awaitingReview,
      blockedWork: r.blockedTasks,
      slaAdherencePct: r.slaAdherencePct,
      escalationsGenerated: p.escalations != null ? p.escalations : (f.critical + f.high),
      findings: f, workloadBand: r.band, openTasks: r.openTasks, capacity: r.capacity
    };
  }).sort((a,b) => (b.findings.critical*100 + b.findings.high*10) - (a.findings.critical*100 + a.findings.high*10));
  res.json({ rows: rows });
}));

router.get('/risk/manager-action-center', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await actionCenterService.getActionCenter());
}));
router.get('/risk/bottlenecks', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await bottleneckService.getBottlenecks());
}));
router.get('/risk/daily-briefing', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await briefingService.getBriefing());
}));
router.get('/risk/follow-up', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await followUpService.getFollowUpBoard());
}));
router.get('/risk/sla-prediction', requireAuth, requireAdmin, asyncH(async function(req, res) {
  // Reuse slaMonitor's statusFor + median estimation from completed history.
  var slaMonitor = require('./slaMonitor');
  var [policies, tasks] = await Promise.all([slaMonitor.getPolicies(), repos.TasksRepo.listAll({ limit: 5000 })]);
  // Build median completion days per task_type from last 90 days.
  var ninety = new Date(Date.now() - 90*24*60*60*1000).toISOString();
  var medianByType = {};
  var samples = {};
  tasks.filter(t => t.status === 'completed' && t.completed_date && t.completed_date >= ninety && t.created_date).forEach(t => {
    var d = (new Date(t.completed_date) - new Date(t.created_date)) / 86400000;
    (samples[t.task_type] = samples[t.task_type] || []).push(d);
  });
  Object.keys(samples).forEach(k => {
    var s = samples[k].slice().sort((a,b)=>a-b);
    medianByType[k] = s[Math.floor(s.length/2)];
  });
  var DAY = 86400000;
  var predictions = [];
  tasks.filter(t => t.status !== 'completed' && t.due_date).forEach(t => {
    var daysLeft = Math.floor((new Date(t.due_date).getTime() - Date.now()) / DAY);
    var est = medianByType[t.task_type] != null ? Math.round(medianByType[t.task_type]) : 7;
    var lowConfidence = (samples[t.task_type] || []).length < 5;
    if (daysLeft < est && !['in_progress','ready_for_review','reviewed'].includes(t.status)) {
      predictions.push({
        taskId: t.id, clientName: t.client_name, taskType: t.task_type,
        status: t.status, dueDate: t.due_date, daysLeft: daysLeft,
        estimatedDaysNeeded: est, lowConfidence: lowConfidence,
        likelyBreachDate: new Date(Date.now() + est*DAY).toISOString().slice(0,10)
      });
    }
  });
  predictions.sort((a,b) => a.daysLeft - b.daysLeft);
  res.json({ predictions: predictions });
}));

// =====================================================================
// PHASE 6 — MIS Reporting Layer
// Thin handlers; all logic in services/reports/*. CSV ships; XLSX/PDF reserved.
// =====================================================================
var periodHelper       = require('./services/reports/periodHelper');
var exportService      = require('./services/exports/exportService');
var employeePerfSvc    = require('./services/reports/employeePerformanceService');
var clientPerfSvc      = require('./services/reports/clientPerformanceService');
var documentDelaySvc   = require('./services/reports/documentDelayService');
var complianceReportSvc= require('./services/reports/complianceReportService');
var escAnalyticsSvc    = require('./services/reports/escalationAnalyticsService');
var workloadAnalyticsSvc=require('./services/reports/workloadAnalyticsService');
var managementSummarySvc=require('./services/reports/managementSummaryService');
var trendsSvc          = require('./services/reports/trendsService');
var attentionSvc       = require('./services/reports/attentionRequiredService');

router.get('/reports/period-options', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(periodHelper.options());
}));

router.get('/reports/employees', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await employeePerfSvc.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'employees', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/clients', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await clientPerfSvc.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'clients', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/document-delays', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await documentDelaySvc.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'document-delays', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/vat-compliance', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await complianceReportSvc.vat.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'vat-compliance', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/ct-compliance', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await complianceReportSvc.ct.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'ct-compliance', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/escalations', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await escAnalyticsSvc.generate(req.query.period, req.query.value);
  exportService.send(req, res, { reportKey:'escalations', label: out.meta.label, columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/reports/workload', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await workloadAnalyticsSvc.generate(req.query.slice || 'user');
  var concentration = await workloadAnalyticsSvc.concentrationRisks();
  exportService.send(req, res, { reportKey:'workload-'+out.slice, label: out.slice, columns: out.columns, rows: out.rows, payload: { slice: out.slice, columns: out.columns, rows: out.rows, concentrationRisks: concentration } });
}));

router.get('/reports/management-summary', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await managementSummarySvc.generate(req.query.month);
  // CSV here flattens the attentionRequired list (most useful tabular slice).
  exportService.send(req, res, {
    reportKey:'management-summary', label: out.meta.label,
    columns: ['clientName','owner','score','readinessState','escalationBand','overdueCount','staleDocsCount','upcomingDeadlineCount'],
    rows: out.attentionRequired || [],
    payload: out
  });
}));

router.get('/reports/trends', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await trendsSvc.generate(req.query.metric, req.query.from, req.query.to));
}));

router.get('/reports/attention-required', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await attentionSvc.generate(parseInt(req.query.limit, 10) || 20);
  exportService.send(req, res, { reportKey:'attention-required', label: 'top', columns: out.columns, rows: out.rows, payload: out });
}));

// =====================================================================
// PHASE 7 — Portfolio Management & Service Governance
// =====================================================================
var clientSettingsSvc      = require('./services/portfolio/clientSettingsService');
var portfolioDashboardSvc  = require('./services/portfolio/portfolioDashboardService');
var portfolioInsightsSvc   = require('./services/portfolio/portfolioInsightsService');
var keyClientAlertsSvc     = require('./services/portfolio/keyClientAlertsService');
var managerActionListSvc   = require('./services/portfolio/managerActionListService');
var clientTimelineSvc      = require('./services/portfolio/clientTimelineService');

router.get('/clients/:id/settings', requireAuth, asyncH(async function(req, res) {
  // Members can read; only admin can write.
  res.json({ settings: await clientSettingsSvc.get(req.params.id) });
}));

router.put('/clients/:id/settings', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var b = req.body || {};
  if (b.tier && ['A','B','C'].indexOf(b.tier) < 0) return res.status(400).json({ error: 'Invalid tier' });
  var saved = await clientSettingsSvc.set(req.params.id, b, { id: req.user.id, name: req.user.name });
  // Re-score priorities so the multiplier takes effect right away.
  try { await taskEngine.recomputeAllPriorities(); } catch (_) {}
  res.json({ settings: saved });
}));

router.get('/clients/:id/portfolio', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await portfolioDashboardSvc.getForClient(req.params.id));
}));

router.get('/clients/:id/timeline', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await clientTimelineSvc.getTimeline(req.params.id, parseInt(req.query.limit, 10) || 200));
}));

router.get('/portfolio/dashboard', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await portfolioDashboardSvc.getDashboard();
  exportService.send(req, res, { reportKey:'portfolio-dashboard', label: 'all', columns: out.columns, rows: out.rows, payload: out });
}));

router.get('/portfolio/insights', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await portfolioInsightsSvc.generate());
}));

router.get('/portfolio/alerts', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await keyClientAlertsSvc.generate());
}));

router.get('/portfolio/manager-action-list', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var out = await managerActionListSvc.generate(parseInt(req.query.limit, 10) || 25);
  exportService.send(req, res, { reportKey:'manager-action-list', label: 'today', columns: out.columns, rows: out.rows, payload: out });
}));

// =====================================================================
// PHASE 8 — AI Operations Assistant (explainable, deterministic, no LLMs)
// =====================================================================
var aiBriefing       = require('./services/ai/dailyBriefingService');
var aiPriority       = require('./services/ai/aiPriorityService');
var aiManagerCopilot = require('./services/ai/managerCopilotService');
var aiTeamCopilot    = require('./services/ai/teamCopilotService');
var aiBottleneckAdv  = require('./services/ai/bottleneckAdvisorService');
var aiClientInsight  = require('./services/ai/clientInsightService');

router.get('/ai/today', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await aiBriefing.generate());
}));

router.get('/ai/priority', requireAuth, asyncH(async function(req, res) {
  res.json(await aiPriority.generate({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
}));

router.get('/ai/my/next-best', requireAuth, asyncH(async function(req, res) {
  res.json(await aiTeamCopilot.getMyNextBest(req.user.id));
}));

router.get('/ai/copilot/questions', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json({ questions: aiManagerCopilot.QUESTIONS });
}));
router.get('/ai/copilot/:question', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await aiManagerCopilot.answer(req.params.question));
}));

router.get('/ai/bottlenecks', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await aiBottleneckAdv.generate());
}));

router.get('/ai/clients/:id/insight', requireAuth, asyncH(async function(req, res) {
  if (req.user.role !== 'admin') {
    var mine = (tracker.getData().clients || []).find(function(c){ return String(c.id) === String(req.params.id) && c.assignedTeam === req.user.name; });
    if (!mine) return res.status(403).json({ error: 'Forbidden' });
  }
  var data = await aiClientInsight.generate(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown client' });
  res.json(data);
}));

router.get('/ai/clients/:id/risk-explanation', requireAuth, requireAdmin, asyncH(async function(req, res) {
  var data = await aiClientInsight.explainRisk(req.params.id);
  if (!data) return res.status(404).json({ error: 'Unknown client' });
  res.json(data);
}));

// =====================================================================
// PHASE 9 — Morning Manager Dashboard
// =====================================================================
var morningDashboardSvc = require('./services/dashboard/morningDashboardService');
router.get('/dashboard/morning', requireAuth, requireAdmin, asyncH(async function(req, res) {
  res.json(await morningDashboardSvc.generate({ force: req.query.refresh === '1' }));
}));

module.exports = router;
