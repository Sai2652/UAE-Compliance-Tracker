// Cognito adapter.
//
// One file wraps every call the app makes into Cognito so the rest of the
// codebase never touches the AWS SDK directly. Two clients live here: the
// JWT verifier (validates access + id tokens on incoming requests) and the
// admin SDK (invite, promote, disable, reset password, list). Both lazy-
// initialised on first use so a cold Lambda that never sees an authed
// request doesn't pay the import cost.

const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const POOL_ID   = process.env.COGNITO_USER_POOL_ID  || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID     || '';
const REGION    = process.env.COGNITO_REGION        || process.env.AWS_REGION_APP || process.env.AWS_REGION || 'ap-south-1';

let _client = null;
function client() {
  if (!POOL_ID || !CLIENT_ID) {
    throw new Error('Cognito is not configured on this Lambda — COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID env vars are missing. Run the CloudFormation deploy (workflow with full_stack: true) so the User Pool is created and the env vars propagate.');
  }
  if (!_client) _client = new CognitoIdentityProviderClient({ region: REGION });
  return _client;
}

// Is Cognito wired up on this Lambda? Callers use this to fall back to the
// legacy JWT path while the CFN deploy hasn't propagated the env vars yet.
function isConfigured() {
  return !!(POOL_ID && CLIENT_ID);
}

// ─── Lazy JWT verifier (aws-jwt-verify) ───────────────────────────
let _verifier = null;
function verifier() {
  if (!isConfigured()) throw new Error('Cognito is not configured — cannot verify JWT.');
  if (_verifier) return _verifier;
  const { CognitoJwtVerifier } = require('aws-jwt-verify');
  _verifier = CognitoJwtVerifier.create({
    userPoolId: POOL_ID,
    tokenUse: 'access',   // We only ever accept access tokens on the API — id tokens stay in the browser.
    clientId: CLIENT_ID,
  });
  return _verifier;
}

// Verify an access token. Returns the decoded payload on success, throws on
// invalid signature / expired / wrong pool / wrong client. Never returns the
// stringly-parsed token itself — callers get a normalised { sub, email, name,
// role, groups[] } shape via userFromToken().
async function verifyAccessToken(token) {
  const payload = await verifier().verify(token);
  return payload;
}

// Normalise the token's Cognito shape into the { id, email, name, role, ... }
// shape the rest of the app has always used. Group membership is the
// authoritative source for role (custom:role attribute is a mirror for the
// browser).
//
// Access tokens don't carry the `email` or `name` attributes — only sub,
// username, groups, custom:*. Callers that need the display name (the
// /auth/me endpoint, for example) should enrich this via getUser(email)
// which hits AdminGetUser. userFromToken keeps a UUID fallback so any
// caller that only wants role + id doesn't pay for that lookup.
function userFromToken(payload) {
  const groups = payload['cognito:groups'] || [];
  // Precedence: super_admin > admin > user. Same order as the group
  // precedence numbers on the User Pool.
  let role = 'user';
  if (groups.includes('super_admin')) role = 'super_admin';
  else if (groups.includes('admin')) role = 'admin';
  return {
    id: payload.sub,       // Cognito's stable user id
    username: payload.username || payload.sub,  // cognito username (may equal sub)
    email: payload.email || '',
    name: payload.name || '',
    role,
    groups,
    reports_to: payload['custom:reports_to'] || null,
    // Legacy shape compat — some code still reads .active. Cognito uses
    // enabled/disabled at the pool level; a token that verifies proves
    // the account is enabled, so this is always true here.
    active: 1,
  };
}

// ─── Invite ─────────────────────────────────────────────────────────
// Uses AdminCreateUser with no MessageAction (default = send invite email).
// Cognito emails the recipient the temp password using the invite template
// declared in template.yaml. On first login the client hits a
// NEW_PASSWORD_REQUIRED challenge — handled by /api/auth/complete-new-password.
async function invite({ email, name, role, reportsTo }) {
  if (!['super_admin', 'admin', 'user'].includes(role)) {
    throw new Error('Invalid role: ' + role);
  }
  const c = client();
  const attrs = [
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: 'true' }, // Skip Cognito's separate verify step; the invite email IS the verification
    { Name: 'name', Value: name },
    { Name: 'custom:role', Value: role },
  ];
  if (reportsTo) attrs.push({ Name: 'custom:reports_to', Value: String(reportsTo) });
  const created = await c.send(new AdminCreateUserCommand({
    UserPoolId: POOL_ID,
    Username: email,
    UserAttributes: attrs,
    DesiredDeliveryMediums: ['EMAIL'],
  }));
  // Group membership drives authorisation server-side. Do this AFTER
  // create so the group's precedence contributes to the JWT's
  // cognito:groups claim on first sign-in.
  await c.send(new AdminAddUserToGroupCommand({
    UserPoolId: POOL_ID,
    Username: email,
    GroupName: role,
  }));
  return { sub: created.User && created.User.Username, email, name, role };
}

// Look up a user by email (== username in our pool).
async function getUser(email) {
  const c = client();
  try {
    const out = await c.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: email }));
    const attrs = {};
    (out.UserAttributes || []).forEach(a => { attrs[a.Name] = a.Value; });
    const groupsOut = await c.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL_ID, Username: email }));
    const groups = (groupsOut.Groups || []).map(g => g.GroupName);
    let role = 'user';
    if (groups.includes('super_admin')) role = 'super_admin';
    else if (groups.includes('admin')) role = 'admin';
    return {
      id: out.Username,
      email: attrs.email || email,
      name: attrs.name || '',
      role,
      groups,
      reports_to: attrs['custom:reports_to'] || null,
      active: out.Enabled ? 1 : 0,
      created_at: out.UserCreateDate ? new Date(out.UserCreateDate).toISOString() : null,
      last_login: out.UserLastModifiedDate ? new Date(out.UserLastModifiedDate).toISOString() : null,
      status: out.UserStatus,
    };
  } catch (e) {
    if (e.name === 'UserNotFoundException') return null;
    throw e;
  }
}

// List every user in the pool (paginated). Used by the frontend's team + user
// management views, and by the assignedTeam picker.
async function listUsers(limit = 60) {
  const c = client();
  const users = [];
  let token = null;
  do {
    const out = await c.send(new ListUsersCommand({ UserPoolId: POOL_ID, Limit: Math.min(60, limit - users.length), PaginationToken: token }));
    for (const u of (out.Users || [])) {
      const attrs = {};
      (u.Attributes || []).forEach(a => { attrs[a.Name] = a.Value; });
      users.push({
        id: u.Username,
        email: attrs.email || '',
        name: attrs.name || '',
        role: attrs['custom:role'] || 'user',  // fast approximation; groups are authoritative but require a per-user call
        active: u.Enabled ? 1 : 0,
        created_at: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
        last_login: u.UserLastModifiedDate ? new Date(u.UserLastModifiedDate).toISOString() : null,
        status: u.UserStatus,
        reports_to: attrs['custom:reports_to'] || null,
      });
    }
    token = out.PaginationToken;
  } while (token && users.length < limit);
  return users;
}

async function deleteUser(email) {
  await client().send(new AdminDeleteUserCommand({ UserPoolId: POOL_ID, Username: email }));
}
async function disableUser(email) {
  await client().send(new AdminDisableUserCommand({ UserPoolId: POOL_ID, Username: email }));
}
async function enableUser(email) {
  await client().send(new AdminEnableUserCommand({ UserPoolId: POOL_ID, Username: email }));
}
async function resetPassword(email) {
  // Sends a "reset your password" email via Cognito. Recipient clicks the
  // code and sets a new password from the login screen's reset flow.
  await client().send(new AdminResetUserPasswordCommand({ UserPoolId: POOL_ID, Username: email }));
}
async function setRole(email, newRole) {
  if (!['super_admin', 'admin', 'user'].includes(newRole)) throw new Error('Invalid role: ' + newRole);
  const c = client();
  // Remove from the other two groups, add to the new one. Cheaper than
  // querying current membership first.
  for (const g of ['super_admin', 'admin', 'user']) {
    if (g === newRole) continue;
    try { await c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL_ID, Username: email, GroupName: g })); }
    catch (e) { if (e.name !== 'ResourceNotFoundException') { /* noop: user wasn't in that group */ } }
  }
  await c.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL_ID, Username: email, GroupName: newRole }));
  await c.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: POOL_ID, Username: email,
    UserAttributes: [{ Name: 'custom:role', Value: newRole }],
  }));
}
async function setReportsTo(email, adminId) {
  await client().send(new AdminUpdateUserAttributesCommand({
    UserPoolId: POOL_ID, Username: email,
    UserAttributes: [{ Name: 'custom:reports_to', Value: adminId ? String(adminId) : '' }],
  }));
}

// ─── First-login password change ─────────────────────────────────
// Called by the /api/auth/complete-new-password endpoint. Runs the two-step
// admin flow: initiate, then respond to NEW_PASSWORD_REQUIRED.
async function completeNewPassword({ email, tempPassword, newPassword, name }) {
  const c = client();
  const init = await c.send(new AdminInitiateAuthCommand({
    UserPoolId: POOL_ID,
    ClientId: CLIENT_ID,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: tempPassword },
  }));
  if (init.ChallengeName !== 'NEW_PASSWORD_REQUIRED') {
    // Already-set user; treat as a normal sign-in and return tokens.
    return init.AuthenticationResult;
  }
  const chal = await c.send(new AdminRespondToAuthChallengeCommand({
    UserPoolId: POOL_ID,
    ClientId: CLIENT_ID,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: init.Session,
    ChallengeResponses: {
      USERNAME: email,
      NEW_PASSWORD: newPassword,
      ...(name ? { 'userAttributes.name': name } : {}),
    },
  }));
  return chal.AuthenticationResult; // { AccessToken, IdToken, RefreshToken, ExpiresIn }
}

module.exports = {
  isConfigured,
  verifyAccessToken,
  userFromToken,
  invite,
  getUser,
  listUsers,
  deleteUser,
  disableUser,
  enableUser,
  resetPassword,
  setRole,
  setReportsTo,
  completeNewPassword,
  config: () => ({ userPoolId: POOL_ID, clientId: CLIENT_ID, region: REGION }),
};
