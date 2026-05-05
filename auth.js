const jwt = require('jsonwebtoken');
const { users } = require('./database');

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
  req.user = { ...decoded, ...user };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin };
