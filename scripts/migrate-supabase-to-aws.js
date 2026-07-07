#!/usr/bin/env node
// One-shot data migration: Supabase (Postgres) → DynamoDB / S3.
// Idempotent — safe to re-run. Each destination row uses the source's primary
// key as its DDB partition key (or as content in the S3 blob).
//
// Prereqs:
//   1. npm install
//   2. npm run bootstrap-aws     (creates DDB tables + S3 bucket)
//   3. Env vars set for BOTH Supabase (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//      and AWS (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//      UCT_S3_BUCKET, UCT_DDB_TABLE_PREFIX).
//   4. Run:  node scripts/migrate-supabase-to-aws.js
//
// Prints a per-table summary. Errors are logged and the script continues so a
// single bad table doesn't block the rest.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const PREFIX = process.env.UCT_DDB_TABLE_PREFIX || 'Uct';
const BUCKET = process.env.UCT_S3_BUCKET;
const SUP_URL = process.env.SUPABASE_URL;
const SUP_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUP_URL || !SUP_KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

const sb = createClient(SUP_URL, SUP_KEY, { auth: { persistSession: false } });
const ddbRaw = new DynamoDBClient({ region: REGION, endpoint: process.env.AWS_ENDPOINT_URL });
const ddb = DynamoDBDocumentClient.from(ddbRaw, { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: REGION, endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: !!process.env.AWS_ENDPOINT_URL });

async function fetchAll(table) {
  const rows = [];
  let from = 0; const pageSize = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
    if (error) { console.warn('  ! fetch ' + table + ':', error.message); return rows; }
    rows.push.apply(rows, data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function batchPut(tableName, items) {
  if (!items.length) return 0;
  // DDB BatchWriteItem allows 25 items per call.
  let written = 0;
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25).map(function(Item) { return { PutRequest: { Item } }; });
    let attempt = 0;
    let unprocessed = { [tableName]: chunk };
    while (Object.keys(unprocessed).length && attempt < 5) {
      const out = await ddb.send(new BatchWriteCommand({ RequestItems: unprocessed }));
      unprocessed = out.UnprocessedItems || {};
      if (Object.keys(unprocessed).length) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      attempt++;
    }
    written += chunk.length;
  }
  return written;
}

function omitNulls(o) {
  const out = {};
  Object.keys(o || {}).forEach(function(k) { if (o[k] != null) out[k] = o[k]; });
  return out;
}

async function migrate(srcTable, destTable, transform) {
  console.log('→ ' + srcTable + ' → ' + PREFIX + destTable);
  const rows = await fetchAll(srcTable);
  if (!rows.length) { console.log('   (empty)'); return; }
  const items = rows.map(function(r) { return omitNulls(transform(r)); });
  const n = await batchPut(PREFIX + destTable, items);
  console.log('   copied ' + n + ' row(s)');
}

async function migrateTrackerStateFromRender() {
  // The in-memory tracker_state never persisted on Render; nothing to migrate
  // from Supabase either. Skip — the AWS S3 blob starts empty and is populated
  // as the user re-saves data through the UI.
  console.log('→ tracker_state: no source (in-memory only on Render); skipping');
}

async function main() {
  console.log('Data migration — Supabase → AWS (region=' + REGION + ')');
  console.log('');

  // Users are seeded by initDatabase() at boot from ADMIN_EMAIL. If Supabase
  // has any additional users beyond the admin, migrate them:
  // (Note: original app never persisted users in Supabase either — they lived
  //  in-memory. If you added users manually and want them preserved, adapt this
  //  section to read from wherever they live.)

  await migrate('compliance_tasks', 'Tasks', function(r) {
    return {
      id: Number(r.id),
      client_external_id: r.client_external_id,
      client_name: r.client_name,
      task_type: r.task_type,
      title: r.title,
      description: r.description,
      assigned_user_id: r.assigned_user_id != null ? Number(r.assigned_user_id) : undefined,
      assigned_user_name: r.assigned_user_name,
      status: r.status,
      review_status: r.review_status,
      reviewer_user_id: r.reviewer_user_id != null ? Number(r.reviewer_user_id) : undefined,
      priority_score: r.priority_score != null ? Number(r.priority_score) : 0,
      due_date: r.due_date,
      compliance_deadline: r.compliance_deadline,
      created_date: r.created_date,
      completed_date: r.completed_date,
      last_status_change: r.last_status_change,
      source: r.source,
      source_key: r.source_key,
      metadata: r.metadata,
      created_by: r.created_by != null ? Number(r.created_by) : undefined,
      updated_at: r.updated_at,
      obligation_id: r.obligation_id != null ? Number(r.obligation_id) : undefined,
      target_start_date: r.target_start_date,
      target_completion_date: r.target_completion_date,
      sla_status: r.sla_status,
      escalation_level: r.escalation_level != null ? Number(r.escalation_level) : 0,
      last_escalated_at: r.last_escalated_at,
      last_activity_at: r.last_activity_at,
      submitted_for_review_at: r.submitted_for_review_at
    };
  });

  await migrate('compliance_task_comments', 'TaskComments', function(r) {
    return {
      task_id: Number(r.task_id),
      created_at: r.created_at,
      user_id: r.user_id != null ? Number(r.user_id) : undefined,
      user_name: r.user_name,
      body: r.body
    };
  });

  await migrate('compliance_document_requests', 'Documents', function(r) {
    return {
      id: Number(r.id),
      task_id: r.task_id != null ? Number(r.task_id) : undefined,
      client_external_id: r.client_external_id,
      client_name: r.client_name,
      document_name: r.document_name,
      notes: r.notes,
      status: r.status,
      requested_date: r.requested_date,
      last_reminder_date: r.last_reminder_date,
      reminder_count: r.reminder_count != null ? Number(r.reminder_count) : 0,
      received_date: r.received_date,
      requested_by_id: r.requested_by_id != null ? Number(r.requested_by_id) : undefined,
      requested_by_name: r.requested_by_name
    };
  });

  await migrate('compliance_obligations', 'Obligations', function(r) {
    return {
      id: Number(r.id),
      client_external_id: r.client_external_id,
      client_name: r.client_name,
      obligation_type: r.obligation_type,
      period_label: r.period_label,
      period_start: r.period_start,
      period_end: r.period_end,
      filing_deadline: r.filing_deadline,
      payment_deadline: r.payment_deadline,
      status: r.status,
      source_key: r.source_key,
      metadata: r.metadata,
      filed_at: r.filed_at,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });

  await migrate('compliance_review_events', 'ReviewEvents', function(r) {
    return {
      id: Number(r.id),
      partition: 'GLOBAL',
      task_id: Number(r.task_id),
      submitted_at: r.submitted_at,
      reviewed_at: r.reviewed_at,
      reviewer_user_id: r.reviewer_user_id != null ? Number(r.reviewer_user_id) : undefined,
      reviewer_user_name: r.reviewer_user_name,
      decision: r.decision,
      turnaround_seconds: r.turnaround_seconds != null ? Number(r.turnaround_seconds) : undefined,
      notes: r.notes
    };
  });

  await migrate('compliance_escalation_events', 'EscalationEvents', function(r) {
    return {
      id: Number(r.id),
      partition: 'GLOBAL',
      task_id: Number(r.task_id),
      rule_id: r.rule_id != null ? Number(r.rule_id) : undefined,
      rule_name: r.rule_name,
      severity: r.severity != null ? Number(r.severity) : 1,
      triggered_at: r.triggered_at,
      resolved_at: r.resolved_at,
      open_partition: r.resolved_at ? undefined : 'OPEN',
      notified: r.notified || [],
      notes: r.notes
    };
  });

  await migrate('compliance_escalation_rules', 'EscalationRules', function(r) {
    return {
      id: Number(r.id), name: r.name, condition_type: r.condition_type,
      threshold_days: Number(r.threshold_days), severity: Number(r.severity),
      notify_owner: !!r.notify_owner, notify_admin: !!r.notify_admin, active: !!r.active
    };
  });

  await migrate('compliance_sla_policies', 'SlaPolicies', function(r) {
    return {
      task_type: r.task_type,
      target_lead_days_start: Number(r.target_lead_days_start),
      target_lead_days_complete: Number(r.target_lead_days_complete),
      at_risk_threshold_days: Number(r.at_risk_threshold_days),
      breach_threshold_days: Number(r.breach_threshold_days),
      updated_at: r.updated_at
    };
  });

  await migrate('compliance_priority_config', 'PriorityConfig', function(r) {
    return { key: r.key, value: Number(r.value), updated_at: r.updated_at };
  });

  await migrate('compliance_health_weights', 'HealthWeights', function(r) {
    return { key: r.key, value: Number(r.value), updated_at: r.updated_at };
  });

  await migrate('compliance_workload_config', 'WorkloadConfig', function(r) {
    return { key: r.key, value: Number(r.value), updated_at: r.updated_at };
  });

  await migrate('compliance_user_capacity', 'UserCapacity', function(r) {
    return {
      user_id: Number(r.user_id),
      user_name: r.user_name,
      capacity_open_tasks: r.capacity_open_tasks != null ? Number(r.capacity_open_tasks) : undefined,
      capacity_weekly_completions: r.capacity_weekly_completions != null ? Number(r.capacity_weekly_completions) : undefined,
      notes: r.notes,
      updated_at: r.updated_at
    };
  });

  await migrate('compliance_workflows', 'Workflows', function(r) {
    return {
      id: Number(r.id),
      client_external_id: r.client_external_id,
      client_name: r.client_name,
      workflow_type: r.workflow_type,
      period_label: r.period_label,
      obligation_id: r.obligation_id != null ? Number(r.obligation_id) : undefined,
      task_id: r.task_id != null ? Number(r.task_id) : undefined,
      current_step_key: r.current_step_key,
      status: r.status,
      source_key: r.source_key,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });

  await migrate('compliance_workflow_steps', 'WorkflowSteps', function(r) {
    return {
      workflow_id: Number(r.workflow_id),
      step_order: Number(r.step_order),
      id: Number(r.id),
      step_key: r.step_key,
      step_label: r.step_label,
      status: r.status,
      responsible_user_id: r.responsible_user_id != null ? Number(r.responsible_user_id) : undefined,
      responsible_user_name: r.responsible_user_name,
      reviewer_user_id: r.reviewer_user_id != null ? Number(r.reviewer_user_id) : undefined,
      completed_at: r.completed_at,
      completed_by_id: r.completed_by_id != null ? Number(r.completed_by_id) : undefined,
      completed_by_name: r.completed_by_name,
      filing_date: r.filing_date,
      notes: r.notes
    };
  });

  await migrate('compliance_client_settings', 'ClientSettings', function(r) {
    return {
      client_external_id: r.client_external_id,
      tier: r.tier || 'B',
      partner_owner: r.partner_owner,
      notes: r.notes,
      override_reason: r.override_reason,
      updated_by_id: r.updated_by_id != null ? Number(r.updated_by_id) : undefined,
      updated_by_name: r.updated_by_name,
      updated_at: r.updated_at
    };
  });

  await migrate('compliance_task_generation_rules', 'TaskGenerationRules', function(r) {
    return {
      id: Number(r.id), task_type: r.task_type, trigger_field: r.trigger_field,
      lead_days: Number(r.lead_days), recurrence: r.recurrence,
      active: !!r.active, default_title: r.default_title, created_at: r.created_at
    };
  });

  await migrateTrackerStateFromRender();

  console.log('');
  console.log('Migration complete.');
}

main().catch(function(e) { console.error('migration failed:', e); process.exit(1); });
