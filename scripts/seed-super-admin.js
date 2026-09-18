// One-shot: create the initial Super Admin in Cognito.
//
// Run ONCE after Batch C1 has deployed and the User Pool exists. Uses the
// ADMIN_EMAIL / ADMIN_PASSWORD (optional) / ADMIN_NAME env vars from .env
// so it can seed the same account that the pre-migration app used to seed
// via bcrypt.
//
// Usage:
//   npm run seed-super-admin
//
// Requires local AWS credentials with cognito-idp:AdminCreateUser permission
// on the pool (the deploy IAM role has this; a local run needs the same).

require('dotenv').config();

const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const POOL_ID = process.env.COGNITO_USER_POOL_ID;
const REGION  = process.env.COGNITO_REGION || process.env.AWS_REGION_APP || process.env.AWS_REGION || 'ap-south-1';
const EMAIL   = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const NAME    = process.env.ADMIN_NAME  || 'Super Admin';
const PW      = process.env.ADMIN_PASSWORD; // Optional — if unset, Cognito emails a random temp password

async function main() {
  if (!POOL_ID) throw new Error('COGNITO_USER_POOL_ID not set — export it from the CloudFormation Outputs (aws cloudformation describe-stacks --stack-name uae-compliance-tracker --query "Stacks[0].Outputs")');
  if (!EMAIL)   throw new Error('ADMIN_EMAIL not set in .env');

  const c = new CognitoIdentityProviderClient({ region: REGION });

  // Idempotent: if the user already exists, skip creation and just ensure
  // the group membership + role attribute are right.
  let exists = false;
  try {
    await c.send(new AdminGetUserCommand({ UserPoolId: POOL_ID, Username: EMAIL }));
    exists = true;
    console.log('User already exists in the pool: ' + EMAIL);
  } catch (e) {
    if (e.name !== 'UserNotFoundException') throw e;
  }

  if (!exists) {
    console.log('Creating super_admin: ' + EMAIL);
    await c.send(new AdminCreateUserCommand({
      UserPoolId: POOL_ID,
      Username: EMAIL,
      UserAttributes: [
        { Name: 'email', Value: EMAIL },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: NAME },
        { Name: 'custom:role', Value: 'super_admin' },
      ],
      // No MessageAction: Cognito sends the branded invite email with a temp password.
      // If ADMIN_PASSWORD is set below, we skip Cognito's email and set the password
      // directly (useful for scripted bootstrap; the user then signs in normally).
      MessageAction: PW ? 'SUPPRESS' : undefined,
      DesiredDeliveryMediums: PW ? [] : ['EMAIL'],
    }));
    console.log('  Created.');
  }

  console.log('Adding to super_admin group…');
  await c.send(new AdminAddUserToGroupCommand({
    UserPoolId: POOL_ID,
    Username: EMAIL,
    GroupName: 'super_admin',
  }));
  console.log('  Group set.');

  if (PW) {
    console.log('Setting permanent password from ADMIN_PASSWORD env var…');
    await c.send(new AdminSetUserPasswordCommand({
      UserPoolId: POOL_ID,
      Username: EMAIL,
      Password: PW,
      Permanent: true,
    }));
    console.log('  Password set (permanent). Sign in at /login with ' + EMAIL);
  } else {
    console.log('No ADMIN_PASSWORD set — Cognito emailed a temporary password to ' + EMAIL);
    console.log('  First sign-in will prompt to set the real password.');
  }
}

main().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('\nSeed failed:', err.message || err);
  process.exit(1);
});
