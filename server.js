require('dotenv').config();
var express = require('express');
var cookieParser = require('cookie-parser');
var path = require('path');
var { initDatabase } = require('./database');
var { verifyToken } = require('./auth');
var apiRoutes = require('./api');
var supabase = require('./supabase');
var taskEngine = require('./taskEngine');
var obligationEngine = require('./obligationEngine');
var escalationEngine = require('./escalationEngine');
var slaMonitor = require('./slaMonitor');

var app = express();
var PORT = process.env.PORT || 3000;

initDatabase();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api', apiRoutes);

app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'login.html')); });
app.get('/signup', function(req, res) { res.sendFile(path.join(__dirname, 'signup.html')); });
app.get('/reset-password', function(req, res) { res.sendFile(path.join(__dirname, 'reset-password.html')); });

app.get('/', function(req, res) {
  var token = req.cookies ? req.cookies.token : null;
  if (!token) return res.redirect('/login');
  var decoded = verifyToken(token);
  if (!decoded) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.get('/admin', function(req, res) {
  var token = req.cookies ? req.cookies.token : null;
  if (!token) return res.redirect('/login');
  var decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('  UAE Compliance Tracker — Cloud Edition');
  console.log('  Running at: http://localhost:' + PORT);
  console.log('  Admin: ' + (process.env.ADMIN_EMAIL || 'admin@tracker.com'));
  console.log('');
  // Compliance / task engine bootstrap (non-fatal if Supabase is missing).
  supabase.probe().then(function(r) {
    if (!r.ok) {
      console.warn('[compliance] Supabase probe failed:', r.error, '— task engine disabled. Run db/schema.sql and set env vars.');
      return;
    }
    console.log('[compliance] Supabase connected — engines starting');
    taskEngine.startScheduler();
    obligationEngine.startScheduler();
    escalationEngine.startScheduler();
    // Recompute SLA statuses once on boot and then hourly.
    setTimeout(function(){ slaMonitor.recomputeAll().catch(function(e){ console.error('[sla] init:', e.message); }); }, 15000);
    setInterval(function(){ slaMonitor.recomputeAll().catch(function(e){ console.error('[sla]:', e.message); }); }, 60 * 60 * 1000);
  }).catch(function(e){ console.warn('[compliance] probe error:', e.message); });
});
