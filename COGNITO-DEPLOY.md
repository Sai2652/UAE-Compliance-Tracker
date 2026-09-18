# Cognito rollout — sequence of steps

The tool ships with a **legacy JWT-in-cookie fallback** and the **new
Cognito path** in the same code. Which one runs is decided by whether
`COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` are set on the Lambda's
environment. That means every batch below can be deployed in any order
without breaking the running app — the legacy path is used until Cognito
env vars actually exist.

## First time (fresh app, no live users)

### 1. Deploy the infrastructure (Batch C1)

Fire the GitHub Actions workflow with `full_stack: true`:

```bash
cd "C:/Users/BCL/Desktop/Claude Repository P/UAE-Compliance-Tracker"
gh workflow run deploy.yml -f full_stack=true
```

Or from the GitHub UI: **Actions → Deploy to AWS → Run workflow → set `full_stack` to `true`**.

The workflow updates the CloudFormation stack, which:

- Creates the Cognito User Pool `uct-users` in `ap-south-1`
- Creates the app client `uct-web`
- Creates three groups (`super_admin`, `admin`, `user`)
- Grants the API Lambda's IAM role the twelve Cognito Admin\* actions
- Sets `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_REGION` on every Lambda's environment

Takes 4–8 minutes on first Cognito create. Watch the run in the Actions tab.

Once green, capture the CFN outputs so you can seed a user:

```bash
aws cloudformation describe-stacks \
  --stack-name uae-compliance-tracker \
  --query "Stacks[0].Outputs" \
  --region ap-south-1
```

You'll get `UserPoolId`, `UserPoolClientId`, `CognitoRegion`.

### 2. Seed the initial Super Admin (Batch C5)

Put the pool ID from step 1 into your local `.env`:

```
COGNITO_USER_POOL_ID=ap-south-1_xxxxxxxxx
COGNITO_REGION=ap-south-1
ADMIN_EMAIL=saikiran@bcl.ae
ADMIN_NAME=Sai
ADMIN_PASSWORD=SomeStrongPw!1     # optional — leave unset for email-invite flow
```

Then:

```bash
npm run seed-super-admin
```

If `ADMIN_PASSWORD` is set, the account is created with that password (permanent, no email sent, ready to sign in). If not, Cognito emails a branded temp password to `ADMIN_EMAIL`; first sign-in prompts to set the real password.

### 3. Sign in and invite the team

Open the live URL, sign in with `saikiran@bcl.ae`. From the sidebar → **User Management** → **Invite someone**, add:

- Admins (team leads) with `Reports to → nobody`
- Users with `Reports to → <their admin>`

Each invite triggers `AdminCreateUser`; Cognito sends the branded invite email with a temp password. The recipient opens `/login`, enters the temp password, is prompted to set a real one.

## What can break, and how the code responds

| Symptom | Cause | What the code does |
|---|---|---|
| Fast-path deploy runs before full_stack | env vars not set yet → `cognito.isConfigured()` returns false | Legacy JWT path runs — no visible change |
| Invite email doesn't arrive | Cognito default sender is capped at 50/day and its deliverability is patchy for some corporate spam filters | Server surfaces the manual URL from `manualLink` on the response — the frontend shows it as a copy button so you can send it manually via WhatsApp |
| Token expires mid-session | 60-min access token | Next API call returns 401, SPA redirects to `/login`, user signs in again. Batch C6 adds silent refresh via the refresh token — not shipped yet |
| Somebody bookmarked `/signup?token=xxx` | Legacy signup URL | `signup.html` is a redirect shim that lands them on `/login` — first sign-in with temp password works the Cognito way |

## Later: switch to SES for prod-grade email

Cognito's default sender caps at 50 emails/day and sends from
`no-reply@verificationemail.com`. For volume + brand deliverability,
verify `bcl.ae` (or `bclworkspace.in`) in SES:

1. In the SES console (same region as the pool, `ap-south-1`), **Verified Identities → Create Identity → Domain**
2. Add the DNS records SES gives you to the domain registrar
3. Once "Verified", update the pool's `EmailConfiguration` in `template.yaml`:
   ```yaml
   EmailConfiguration:
     EmailSendingAccount: DEVELOPER
     From: 'BCL <no-reply@bcl.ae>'
     SourceArn: !Sub 'arn:aws:ses:${AWS::Region}:${AWS::AccountId}:identity/bcl.ae'
   ```
4. Re-deploy with `full_stack: true`

## When it's safe to delete the legacy code (Batch C6)

Once you've verified for a week or two that everyone signs in through
Cognito cleanly, do a clean-up pass:

- Remove `bcryptjs`, `jsonwebtoken` from `package.json`
- Remove the `legacy` branches from `api.js` (`/auth/login`, `/auth/reset-password`, `/invite/signup`, `/invite/verify/:token`)
- Remove the Resend invite/reset templates from `email.js` (escalation/digest templates stay)
- Drop the `ADMIN_PASSWORD`, `JWT_SECRET` CloudFormation parameters
- Delete `UsersDataRepo` from `repositories/` and the `users.*` methods in `database.js` — every reader now goes through `cognito.getUser` / `cognito.listUsers`

Save that for a separate commit called "Batch C6 · legacy auth removal" once the migration is proven.
