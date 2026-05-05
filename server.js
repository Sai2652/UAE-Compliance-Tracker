require('dotenv').config();
var express = require('express');
var cookieParser = require('cookie-parser');
var path = require('path');
var { initDatabase } = require('./database');
var { verifyToken } = require('./auth');
var apiRoutes = require('./api');

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
});
