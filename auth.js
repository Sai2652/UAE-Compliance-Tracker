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

// Enrichment cache — Cognito access tokens don't carry the `email` or
// `name` attributes, only sub + groups. Every request that relies on
// req.user.name (client visibility, activity log lines, invite matrix,
// "sees my downline" checks) was previously running against name:''.
// That silently broke visibility for every Cognito-native user:
// clientScope built a names-set of {''}, matched no clients, and
// showed the newly-invited Admin nothing they had actually been given.
// One AdminGetUser call per user per warm Lambda closes it. TTL 5 min
// so a name/role edit propagates without a cold-start.
const _userEnrichCache = new Map(); // sub -> { at, name, email, groups }
const ENRICH_TTL_MS = 5 * 60 * 1000;
async function _enrichFromCognito(user) {
  if (!user || (user.name && user.email)) return user;
  const key = user.id;
  const hit = _userEnrichCache.get(key);
  if (hit && (Date.now() - hit.at) < ENRICH_TTL_MS) {
    if (!user.name)  user.name  = hit.name  || '';
    if (!user.email) user.email = hit.email || '';
    return user;
  }
  try {
    const full = await cognito.getUser(user.username || user.email || user.id);
    if (full) {
      if (!user.name)  user.name  = full.name  || '';
      if (!user.email) user.email = full.email || '';
      if (full.role && (!user.role || user.role === 'user')) user.role = full.role;
      _userEnrichCache.set(key, { at: Date.now(), name: user.name, email: user.email });
    }
  } catch (e) {
    // Don't fail the request over one Cognito hiccup — the caller keeps
    // whatever req.user shape it already had, name may be empty for this call.
    console.error('[auth] cognito enrichment failed for', key, ':', e && e.message);
  }
  return user;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    if (cognito.isConfigured()) {
      // Cognito path. verifyAccessToken throws on bad signature / expired /
      // wrong pool. Downstream code sees the same { id, email, role, ... }
      // shape it always has, with name/email backfilled from AdminGetUser
      // (cached per-user, 5 min) so client-scoping actually works.
      const payload = await cognito.verifyAccessToken(token);
      req.user = cognito.userFromToken(payload);
      await _enrichFromCognito(req.user);
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
