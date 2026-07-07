# UAE Compliance Tracker — AWS Deployment Guide

This app now runs entirely on AWS: **Lambda + API Gateway** for the API,
**DynamoDB** for structured data, **S3** for the clients/team blob,
**EventBridge** for the 4 background schedulers.

Everything is provisioned in region **`ap-south-1` (Mumbai)** by default.

---

## Prerequisites (install once)

On your local machine:

1. **Node.js 20+** — check with `node --version`.
2. **AWS CLI v2** — [install](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then:
   ```bash
   aws configure
   # AWS Access Key ID:     <your key>
   # AWS Secret Access Key: <your secret>
   # Default region:        ap-south-1
   # Default output:        json
   ```
3. **AWS SAM CLI** — [install](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html), verify with `sam --version`.
4. **Docker Desktop** — required by `sam build` when packaging Node deps.

---

## Step 1 — Create the AWS account resources

You'll do these once, in the AWS console:

### 1a. Create an IAM user for the app (if you don't already have one)

- Console → IAM → Users → **Create user** → name `uct-admin`
- Attach policy: `AdministratorAccess` (simplest for solo setup; can tighten later)
- Create access key → save the key/secret in `aws configure`.

### 1b. Pick a globally-unique S3 bucket name

Something like `uct-tracker-state-anyah-x7q4`. It must be globally unique across all AWS accounts.

---

## Step 2 — Set env vars locally

Create `.env` in the repo root (already git-ignored):

```bash
AWS_REGION=ap-south-1
UCT_DDB_TABLE_PREFIX=Uct
UCT_S3_BUCKET=uct-tracker-state-anyah-x7q4   # your unique bucket

# Admin seed (used at first boot)
ADMIN_EMAIL=saikiran@bcl.ae
ADMIN_PASSWORD=Change_This_Strong_Password_1!
ADMIN_NAME=Sai

# JWT (any long random string; keep secret)
JWT_SECRET=REPLACE-WITH-LONG-RANDOM-STRING-64-CHARS

# Optional: SMTP for outbound emails (leave blank to disable)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
APP_URL=
```

---

## Step 3 — Bootstrap DynamoDB tables + S3 bucket

```bash
npm install
npm run bootstrap-aws
```

This creates:
- 17 DynamoDB tables (`UctUsers`, `UctTasks`, `UctObligations`, `UctDocuments`,
  `UctTaskComments`, `UctTaskGenerationRules`, `UctActivityLog`,
  `UctReviewEvents`, `UctEscalationEvents`, `UctEscalationRules`,
  `UctSlaPolicies`, `UctPriorityConfig`, `UctHealthWeights`,
  `UctWorkloadConfig`, `UctUserCapacity`, `UctWorkflows`,
  `UctWorkflowSteps`, `UctClientSettings`)
- The S3 bucket (with versioning enabled)
- Seed rows for config tables (SLA policies, escalation rules, priority
  weights, health weights, task-generation rules, workload knobs)

It's **idempotent** — safe to re-run any time.

---

## Step 4 — (Optional) Migrate data from Supabase

Only if you want to bring your existing client/task/obligation data over.

```bash
# .env must additionally contain:
# SUPABASE_URL=https://qpxdifpobhkulecxklym.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=<from Supabase project settings>

npm run migrate-data
```

Copies every `compliance_*` table from Supabase into the matching DynamoDB
table. Idempotent — safe to re-run. Prints per-table row counts.

**Not applicable to the clients/team list** — that was in-memory only on
Render, so nothing to migrate. Re-enter through the UI on first login.

---

## Step 5 — Deploy the Lambda + API Gateway + EventBridge stack

```bash
sam build
sam deploy --guided
```

The guided prompts (first time only):

| Prompt | Answer |
|---|---|
| Stack Name | `uae-compliance-tracker` |
| AWS Region | `ap-south-1` |
| Parameter AdminEmail | your email |
| Parameter AdminPassword | strong password |
| Parameter AdminName | your name |
| Parameter JwtSecret | any long random string |
| Parameter S3Bucket | the bucket name from Step 2 |
| Parameter DdbPrefix | `Uct` |
| Parameter Smtp* | leave blank for now |
| Parameter AppUrl | leave blank first time |
| Confirm changes before deploy | Y |
| Allow SAM CLI IAM role creation | Y |
| Save arguments to samconfig.toml | Y |

After `sam deploy` succeeds it prints the `ApiUrl` in Outputs. Copy it —
something like:

```
https://abc123xyz.execute-api.ap-south-1.amazonaws.com
```

Now re-run `sam deploy` **once more** with that value as `AppUrl` (SAM
remembers it in `samconfig.toml`). This lets outbound emails link back to
the app correctly.

---

## Step 6 — Verify it's running

```bash
curl https://YOUR-API-URL/health
# {"ok":true,"ts":"2026-..."}
```

Open the URL in a browser → you'll be redirected to `/login`. Sign in with
the admin email/password you configured. If login succeeds and the app
loads, everything is wired.

**Cold start note**: first Lambda invocation may take ~2-3 seconds while it
hydrates from DynamoDB. Subsequent requests are fast (~50ms).

---

## Step 7 — (Optional) Custom domain + Amplify Hosting

The default API Gateway URL works fine but is ugly. If you want a nicer URL
like `tracker.anyah.com`:

1. **Route 53** → register/import your domain
2. **ACM** (`ap-south-1`) → request a public certificate for that domain
3. **API Gateway** → Custom domain names → add domain, attach ACM cert
4. **Route 53** → alias record pointing to the API Gateway domain

For Amplify Hosting of the static HTML separately (optional — the Lambda
already serves them fine), you can point Amplify at this repo and set the
build spec to just copy the HTML files. Not required for the app to work.

---

## What to know about ongoing operations

### Where things are in the AWS console

- **DynamoDB** → 17 `Uct*` tables. Each has your data. Free-tier: 25 GB
  storage + 25 WCU + 25 RCU forever.
- **S3** → your `uct-tracker-state-*` bucket, one object `tracker_state.json`.
- **Lambda** → 5 functions: `uae-compliance-tracker-ApiFunction-*` (the
  API), plus 4 `*CronFunction-*` (schedulers).
- **API Gateway** → HTTP API with a single catch-all route to `ApiFunction`.
- **EventBridge** → 5 scheduled rules (hourly SLA, hourly rescore + daily
  generate for tasks, daily obligation sync, hourly escalation + daily
  admin digest).
- **CloudWatch Logs** → `/aws/lambda/uae-compliance-tracker-*` — one log
  group per function. That's where all `console.log` output goes.
- **IAM** → one role per Lambda, scoped to only the DynamoDB tables and
  S3 bucket it needs.

### Redeploying after a code change

```bash
sam build && sam deploy
```

Takes ~30-60 seconds. Users see zero downtime — API Gateway swaps the
Lambda alias atomically.

### Adjusting cron schedules

Edit the `Schedule:` lines in `template.yaml`, then `sam deploy`. Cron
syntax is [standard cron](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-cron-expressions.html)
in **UTC** (Mumbai is UTC+5:30).

### Rolling back

Every deploy is a new CloudFormation stack version. In the AWS console:
CloudFormation → stack → Update → **Rollback** to a previous version.

### Cost expectations (based on your usage patterns)

Everything sits inside AWS Always-Free at this volume:
- DynamoDB: 25 WCU/RCU forever — you'll use maybe 2-3 WCU/RCU
- Lambda: 1M requests + 400k GB-sec free forever — you'll use a few hundred req/day
- API Gateway HTTP API: 1M free for 12 months, then $1/M
- CloudWatch Logs: 5 GB/month free — plenty
- S3: 5 GB free for 12 months, then ~$0.023/GB — negligible for one 100KB file

**Expected monthly bill**: $0 for the first 12 months, then roughly $1-2/month
after that.

---

## Uninstalling (safe delete)

```bash
sam delete
```

Then in the console:
- DynamoDB → delete the 17 `Uct*` tables
- S3 → empty and delete the bucket
- IAM → optionally delete the user

CloudFormation retains nothing.

---

## Getting help

- **Lambda errors** → CloudWatch Logs → the relevant function's log group.
  Every error is logged with `console.error`.
- **App errors** → same place, in the `ApiFunction` log group.
- **Local reproduction** → set the AWS env vars in `.env`, run `npm start`,
  hit `http://localhost:3000`. The app talks to real AWS from your laptop.
