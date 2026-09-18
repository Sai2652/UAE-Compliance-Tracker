// Auth middleware.
//
// Two modes, gated by whether Cognito is wired up on this Lambda:
//   * Cognito mode — accepts a Cognito ACCESS TOKEN in the Authorization
//     header (Bearer ...) or in the `token` cookie. Verified against the
//     User Pool's JWKS; groups + custom:role drive authorisation.
//   * Legacy mode  — the pre-Cognito JWT-in-cookie flow, kept alive while
//     the CFN full_stack deploy hasn't yet propagated COGNITO_USER_POOL_ID.
//     Deleted in Batch C6 once every environment has switched.
//
// Rather than pick the mode per request, we pick once at import time based
// on env presence. Once Cognito is on, the legacy path never runs again.

const jwt = require('jsonwebtoken');
const cognito = require('./cognito');
const roles = require('./roles');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

function generateToken(user) {
  // Legacy-only: mints a JWT the /auth/login endpoint stores in a cookie.
  // When Cognito is on, /auth/login doesn't call this — the browser holds
  // Cognito tokens and sends AccessToken in the Authorization header.
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  // Legacy verify — synchronous, used by app.js for the root / gate.
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

// Extract the token from a request. Prefer Authorization header (Cognito's
// natural spot); fall back to the cookie for the legacy flow and for the
// server-side page gates in app.js.
function extractToken(req) {
  const h = req.headers && req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    if (cognito.isConfigured()) {
      // Cognito path. verifyAccessToken throws on bad signature / expired /
      // wrong pool. Downstream code sees the same { id, email, role, ... }
      // shape it always has.
      const payload = await cognito.verifyAccessToken(token);
      req.user = cognito.userFromToken(payload);
      return next();
    }
    // Legacy path. Cognito hasn't propagated yet; the app still runs on
    // the pre-migration JWT flow. Loaded lazily so a Cognito-only build
    // never imports the DynamoDB user store.
    const { users } = require('./database');
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });
    const user = users.findById(decoded.id);
    if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = { ...decoded, ...user, role: roles.normalizeRole(user.role) };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// "Admin or above" — Admin, Super Admin, or Prime Admin. Data scoping happens
// per-endpoint in roles.js; this only gates the management surfaces.
function requireAdmin(req, res, next) {
  if (!roles.atLeast(req.user, 'admin')) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// "Super Admin or above" — Super Admin or Prime Admin. Gates settings that
// span a whole downline (invite an Admin, edit a Super Admin's book etc.).
function requireSuperAdmin(req, res, next) {
  if (!roles.atLeast(req.user, 'super_admin')) return res.status(403).json({ error: 'Super Admin access required' });
  next();
}

// Firm-wide power — inviting Super Admins, editing prime_admin settings.
// Only the founder.
function requirePrimeAdmin(req, res, next) {
  if (!roles.isPrimeAdmin(req.user)) return res.status(403).json({ error: 'Prime Admin access required' });
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireAdmin, requireSuperAdmin, requirePrimeAdmin, extractToken };
