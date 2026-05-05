const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { users, tracker, activity } = require('./database');
const { generateToken, requireAuth, requireAdmin } = require('./auth');
const { sendInviteEmail, sendResetEmail } = require('./email');
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
  res.json({ ok: true });
});

router.get('/activity', requireAuth, function(req, res) { 
  var all = activity.getRecent(parseInt(req.query.limit) || 50);
  if (req.user.role !== 'admin') {
    all = all.filter(function(a) { return a.user_id === req.user.id; });
  }
  res.json({ activities: all }); 
});

module.exports = router;
