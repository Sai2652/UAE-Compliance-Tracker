// Express app factory — used by both server.js (local dev) and lambda.js.
// No process.env.PORT / app.listen here; those live in server.js.
require('dotenv').config();
var express = require('express');
var cookieParser = require('cookie-parser');
var path = require('path');
var { verifyToken } = require('./auth');
var apiRoutes = require('./api');

function buildApp() {
  var app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use('/api', apiRoutes);

  app.get('/health', function(req, res) { res.json({ ok: true, ts: new Date().toISOString() }); });

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

  // The standalone admin page is gone — user management is a page inside the
  // app now (sidebar → User Management). This route stays only to catch old
  // bookmarks and send them somewhere useful.
  //
  // Worth recording why it went: it tested `decoded.role !== 'admin'`, and
  // once roles became super_admin / admin / user, a Super Admin failed that
  // test and was redirected away. The one person who most needed the admin
  // panel was the one person who could not open it, which is why the 11px ⚙
  // in the header looked simply broken.
  app.get('/admin', function(req, res) {
    var token = req.cookies ? req.cookies.token : null;
    if (!token) return res.redirect('/login');
    res.redirect('/');
  });

  return app;
}

module.exports = { buildApp };
