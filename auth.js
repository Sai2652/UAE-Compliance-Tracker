const jwt = require('jsonwebtoken');
const { users } = require('./database');
const roles = require('./roles');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  const user = users.findById(decoded.id);
  if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });
  // The stored record wins over the token, so a role or reporting-line change
  // takes effect on the next request instead of after a re-login. Normalising
  // here means every downstream check sees one of the three current roles even
  // for an account still carrying a legacy value.
  req.user = { ...decoded, ...user, role: roles.normalizeRole(user.role) };
  next();
}

// "Admin or above" — a team lead or the manager. Gates the management views;
// what DATA those views return is scoped separately, in roles.js.
function requireAdmin(req, res, next) {
  if (!roles.atLeast(req.user, 'admin')) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Firm-wide settings and user management. A team lead running one of two teams
// has no business editing escalation rules or promoting people.
function requireSuperAdmin(req, res, next) {
  if (!roles.isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super Admin access required' });
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin, requireSuperAdmin };
