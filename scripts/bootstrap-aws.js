#!/usr/bin/env node
// Idempotent AWS bootstrap: creates every DynamoDB table + the S3 bucket the
// app needs, using the same naming convention aws.js uses at runtime.
//
// Safe to re-run. Skips resources that already exist.
//
// This script grows one Session at a time. Session 1 provisions the
// resources the redone Phase 1 needs (Users, ActivityLog, tracker-state
// bucket). Later sessions extend TABLES[] with the remaining 13 tables.
//
// Usage:  node scripts/bootstrap-aws.js
// Required env: AWS_REGION, UCT_S3_BUCKET, and either AWS credentials in
//   env / ~/.aws/credentials or an assumed IAM role.

require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketVersioningCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const PREFIX = process.env.UCT_DDB_TABLE_PREFIX || 'Uct';
const BUCKET = process.env.UCT_S3_BUCKET;

const ddb = new DynamoDBClient({ region: REGION, endpoint: process.env.AWS_ENDPOINT_URL });
const s3 = new S3Client({
  region: REGION,
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: !!process.env.AWS_ENDPOINT_URL
});

// Kept only so the table definitions below stay valid JavaScript. ensureTable()
// strips these and creates every table on demand instead — see onDemand() for
// why the original per-table reasoning about the free tier was wrong.
const CAPACITY = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };

const TABLES = [
  {
    // Session 1
    TableName: PREFIX + 'Users',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'email', AttributeType: 'S' },
      { AttributeName: 'invite_token', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'email-index',
        KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'invite_token-index',
        KeySchema: [{ AttributeName: 'invite_token', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },
  {
    // Session 1
    TableName: PREFIX + 'ActivityLog',
    KeySchema: [
      { AttributeName: 'partition', KeyType: 'HASH' },
      { AttributeName: 'created_at', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'partition', AttributeType: 'S' },
      { AttributeName: 'created_at', AttributeType: 'S' }
    ],
    ProvisionedThroughput: CAPACITY
  },

  // ---------- Session 2 ----------

  {
    TableName: PREFIX + 'Tasks',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'source_key', AttributeType: 'S' },
      { AttributeName: 'assigned_user_id', AttributeType: 'N' },
      { AttributeName: 'client_external_id', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'due_date', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'source_key-index',
        KeySchema: [{ AttributeName: 'source_key', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'assignee-index',
        KeySchema: [
          { AttributeName: 'assigned_user_id', KeyType: 'HASH' },
          { AttributeName: 'due_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'client-index',
        KeySchema: [
          { AttributeName: 'client_external_id', KeyType: 'HASH' },
          { AttributeName: 'due_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'status-index',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'due_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'Obligations',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'source_key', AttributeType: 'S' },
      { AttributeName: 'client_external_id', AttributeType: 'S' },
      { AttributeName: 'filing_deadline', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'source_key-index',
        KeySchema: [{ AttributeName: 'source_key', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'client-index',
        KeySchema: [
          { AttributeName: 'client_external_id', KeyType: 'HASH' },
          { AttributeName: 'filing_deadline', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'Documents',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'client_external_id', AttributeType: 'S' },
      { AttributeName: 'task_id', AttributeType: 'N' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'requested_date', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'client-index',
        KeySchema: [
          { AttributeName: 'client_external_id', KeyType: 'HASH' },
          { AttributeName: 'requested_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'task-index',
        KeySchema: [
          { AttributeName: 'task_id', KeyType: 'HASH' },
          { AttributeName: 'requested_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'status-index',
        KeySchema: [
          { AttributeName: 'status', KeyType: 'HASH' },
          { AttributeName: 'requested_date', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'TaskComments',
    KeySchema: [
      { AttributeName: 'task_id', KeyType: 'HASH' },
      { AttributeName: 'created_at', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'task_id', AttributeType: 'N' },
      { AttributeName: 'created_at', AttributeType: 'S' }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'TaskGenerationRules',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' }
    ],
    ProvisionedThroughput: CAPACITY
  },

  // ---------- Session 3 ----------

  {
    TableName: PREFIX + 'ReviewEvents',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'partition', AttributeType: 'S' },
      { AttributeName: 'reviewed_at', AttributeType: 'S' },
      { AttributeName: 'task_id', AttributeType: 'N' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'time-index',
        KeySchema: [
          { AttributeName: 'partition', KeyType: 'HASH' },
          { AttributeName: 'reviewed_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'task-index',
        KeySchema: [
          { AttributeName: 'task_id', KeyType: 'HASH' },
          { AttributeName: 'reviewed_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'EscalationEvents',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'partition', AttributeType: 'S' },
      { AttributeName: 'triggered_at', AttributeType: 'S' },
      { AttributeName: 'task_id', AttributeType: 'N' },
      { AttributeName: 'open_partition', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'time-index',
        KeySchema: [
          { AttributeName: 'partition', KeyType: 'HASH' },
          { AttributeName: 'triggered_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'task-index',
        KeySchema: [
          { AttributeName: 'task_id', KeyType: 'HASH' },
          { AttributeName: 'triggered_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'open-index',
        KeySchema: [
          { AttributeName: 'open_partition', KeyType: 'HASH' },
          { AttributeName: 'triggered_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'EscalationRules',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'SlaPolicies',
    KeySchema: [{ AttributeName: 'task_type', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'task_type', AttributeType: 'S' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'PriorityConfig',
    KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'HealthWeights',
    KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'WorkloadConfig',
    KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'UserCapacity',
    KeySchema: [{ AttributeName: 'user_id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'user_id', AttributeType: 'N' }],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'Workflows',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'N' },
      { AttributeName: 'source_key', AttributeType: 'S' },
      { AttributeName: 'client_external_id', AttributeType: 'S' },
      { AttributeName: 'updated_at', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'source_key-index',
        KeySchema: [{ AttributeName: 'source_key', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      },
      {
        IndexName: 'client-index',
        KeySchema: [
          { AttributeName: 'client_external_id', KeyType: 'HASH' },
          { AttributeName: 'updated_at', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: CAPACITY
      }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'WorkflowSteps',
    KeySchema: [
      { AttributeName: 'workflow_id', KeyType: 'HASH' },
      { AttributeName: 'step_order', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'workflow_id', AttributeType: 'N' },
      { AttributeName: 'step_order', AttributeType: 'N' }
    ],
    ProvisionedThroughput: CAPACITY
  },

  {
    TableName: PREFIX + 'ClientSettings',
    KeySchema: [{ AttributeName: 'client_external_id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'client_external_id', AttributeType: 'S' }],
    ProvisionedThroughput: CAPACITY
  }
];

// Seed rows for tables that Postgres populated with INSERT ... ON CONFLICT DO NOTHING.
const SEEDS = {
  [PREFIX + 'TaskGenerationRules']: [
    { id: 1, task_type: 'VAT_Filing',        trigger_field: 'vatDueDate',          lead_days: 21, recurrence: 'quarterly', active: true, default_title: 'VAT Filing' },
    { id: 2, task_type: 'CT_Filing',         trigger_field: 'ctDueDate',           lead_days: 30, recurrence: 'annual',    active: true, default_title: 'Corporate Tax Filing' },
    { id: 3, task_type: 'VAT_Registration',  trigger_field: 'vatRegistrationDue',  lead_days: 14, recurrence: 'once',      active: true, default_title: 'VAT Registration' },
    { id: 4, task_type: 'CT_Registration',   trigger_field: 'ctRegistrationDue',   lead_days: 14, recurrence: 'once',      active: true, default_title: 'CT Registration' },
    { id: 5, task_type: 'Audit',             trigger_field: 'auditDueDate',        lead_days: 30, recurrence: 'annual',    active: true, default_title: 'Annual Audit' },
    { id: 6, task_type: 'Management_Report', trigger_field: 'reportingDate',       lead_days: 7,  recurrence: 'monthly',   active: true, default_title: 'Management Report' }
  ],

  [PREFIX + 'EscalationRules']: [
    { id: 1, name: 'No activity 5 days',            condition_type: 'no_updates',           threshold_days: 5,  severity: 1, notify_owner: true,  notify_admin: false, active: true },
    { id: 2, name: 'No activity 10 days',           condition_type: 'no_updates',           threshold_days: 10, severity: 2, notify_owner: true,  notify_admin: true,  active: true },
    { id: 3, name: 'Documents pending 7 days',      condition_type: 'docs_pending',         threshold_days: 7,  severity: 1, notify_owner: true,  notify_admin: false, active: true },
    { id: 4, name: 'Documents pending 14 days',     condition_type: 'docs_pending',         threshold_days: 14, severity: 2, notify_owner: true,  notify_admin: true,  active: true },
    { id: 5, name: 'Awaiting review 3 days',        condition_type: 'review_backlog',       threshold_days: 3,  severity: 1, notify_owner: false, notify_admin: true,  active: true },
    { id: 6, name: 'Awaiting review 7 days',        condition_type: 'review_backlog',       threshold_days: 7,  severity: 2, notify_owner: false, notify_admin: true,  active: true },
    { id: 7, name: 'Not started within 7d of due',  condition_type: 'not_started',          threshold_days: 7,  severity: 2, notify_owner: true,  notify_admin: true,  active: true },
    { id: 8, name: 'Deadline within 3 days',        condition_type: 'deadline_approaching', threshold_days: 3,  severity: 2, notify_owner: true,  notify_admin: true,  active: true },
    { id: 9, name: 'Deadline within 1 day',         condition_type: 'deadline_approaching', threshold_days: 1,  severity: 3, notify_owner: true,  notify_admin: true,  active: true }
  ],

  [PREFIX + 'SlaPolicies']: [
    { task_type: 'VAT_Filing',            target_lead_days_start: 21, target_lead_days_complete: 5,  at_risk_threshold_days: 7,  breach_threshold_days: 0 },
    { task_type: 'CT_Filing',             target_lead_days_start: 45, target_lead_days_complete: 7,  at_risk_threshold_days: 14, breach_threshold_days: 0 },
    { task_type: 'VAT_Registration',      target_lead_days_start: 14, target_lead_days_complete: 2,  at_risk_threshold_days: 5,  breach_threshold_days: 0 },
    { task_type: 'VAT_Deregistration',    target_lead_days_start: 14, target_lead_days_complete: 2,  at_risk_threshold_days: 5,  breach_threshold_days: 0 },
    { task_type: 'CT_Registration',       target_lead_days_start: 14, target_lead_days_complete: 2,  at_risk_threshold_days: 5,  breach_threshold_days: 0 },
    { task_type: 'CT_Deregistration',     target_lead_days_start: 14, target_lead_days_complete: 2,  at_risk_threshold_days: 5,  breach_threshold_days: 0 },
    { task_type: 'Audit',                 target_lead_days_start: 30, target_lead_days_complete: 5,  at_risk_threshold_days: 14, breach_threshold_days: 0 },
    { task_type: 'Accounting_Bookkeeping',target_lead_days_start: 7,  target_lead_days_complete: 1,  at_risk_threshold_days: 3,  breach_threshold_days: 0 },
    { task_type: 'Management_Report',     target_lead_days_start: 7,  target_lead_days_complete: 1,  at_risk_threshold_days: 3,  breach_threshold_days: 0 },
    { task_type: 'Document_Request',      target_lead_days_start: 3,  target_lead_days_complete: 0,  at_risk_threshold_days: 2,  breach_threshold_days: 0 },
    { task_type: 'Review',                target_lead_days_start: 3,  target_lead_days_complete: 0,  at_risk_threshold_days: 2,  breach_threshold_days: 0 },
    { task_type: 'Amendment',             target_lead_days_start: 7,  target_lead_days_complete: 1,  at_risk_threshold_days: 3,  breach_threshold_days: 0 },
    { task_type: 'Refund',                target_lead_days_start: 14, target_lead_days_complete: 2,  at_risk_threshold_days: 5,  breach_threshold_days: 0 },
    { task_type: 'Client_Followup',       target_lead_days_start: 2,  target_lead_days_complete: 0,  at_risk_threshold_days: 1,  breach_threshold_days: 0 },
    { task_type: 'Other',                 target_lead_days_start: 7,  target_lead_days_complete: 1,  at_risk_threshold_days: 3,  breach_threshold_days: 0 }
  ],

  [PREFIX + 'PriorityConfig']: [
    { key: 'overdue',                       value: 100 },
    { key: 'due_within_7d',                 value: 50  },
    { key: 'compliance_deadline_within_14d',value: 40  },
    { key: 'blocked',                       value: 30  },
    { key: 'pending_day',                   value: 2   },
    { key: 'waiting_review_over_3d',        value: 20  },
    { key: 'missing_docs_over_7d',          value: 25  }
  ],

  [PREFIX + 'HealthWeights']: [
    { key: 'base_score',                   value: 100 },
    { key: 'overdue_per_task',             value: 15  },
    { key: 'overdue_cap',                  value: 40  },
    { key: 'blocked_per_task',             value: 10  },
    { key: 'blocked_cap',                  value: 25  },
    { key: 'doc_pending_over_7d',          value: 5   },
    { key: 'review_pending_over_3d',       value: 5   },
    { key: 'unstarted_deadline_within_7d', value: 10  },
    { key: 'recent_activity_bonus',        value: 5   },
    { key: 'band_healthy',                 value: 80  },
    { key: 'band_watch',                   value: 60  },
    { key: 'band_at_risk',                 value: 40  }
  ],

  [PREFIX + 'WorkloadConfig']: [
    // phase3 defaults
    { key: 'default_capacity_open_tasks', value: 20 },
    { key: 'band_underutilized_max',      value: 0.60 },
    { key: 'band_overloaded_min',         value: 1.10 },
    { key: 'forecast_days',               value: 30 },
    { key: 'communication_silence_days',  value: 14 },
    { key: 'review_aging_warn_days',      value: 3 },
    { key: 'review_aging_alarm_days',     value: 7 },
    // phase4_minimal / phase5 risk knobs
    { key: 'risk_no_activity_medium_days', value: 5 },
    { key: 'risk_no_activity_high_days',   value: 10 },
    { key: 'risk_overdue_critical_days',   value: 7 },
    { key: 'risk_docs_pending_medium',     value: 7 },
    { key: 'risk_docs_pending_high',       value: 14 },
    { key: 'risk_registration_high_days',  value: 30 },
    { key: 'risk_review_high_days',        value: 7 },
    { key: 'risk_deadline_critical_days',  value: 2 },
    { key: 'risk_deadline_high_days',      value: 7 },
    { key: 'client_score_band_amber',      value: 16 },
    { key: 'client_score_band_red',        value: 40 },
    { key: 'client_score_critical_weight', value: 25 },
    { key: 'client_score_high_weight',     value: 10 },
    { key: 'client_score_medium_weight',   value: 3 },
    { key: 'client_score_low_weight',      value: 1 },
    { key: 'bottleneck_min_items',         value: 3 },
    // phase7 portfolio knobs
    { key: 'tier_a_multiplier', value: 1.50 },
    { key: 'tier_b_multiplier', value: 1.00 },
    { key: 'tier_c_multiplier', value: 0.75 },
    { key: 'resp_base', value: 100 },
    { key: 'resp_per_stale_doc', value: 8 },
    { key: 'resp_stale_doc_cap', value: 40 },
    { key: 'resp_per_waiting_docs_14d', value: 10 },
    { key: 'resp_waiting_docs_cap', value: 30 },
    { key: 'resp_per_missed_confirm', value: 15 },
    { key: 'resp_missed_confirm_cap', value: 45 },
    { key: 'resp_per_reminder', value: 2 },
    { key: 'resp_reminder_cap', value: 20 },
    { key: 'resp_recent_response_bonus', value: 5 },
    { key: 'effort_per_open_task', value: 1.5 },
    { key: 'effort_open_cap', value: 40 },
    { key: 'effort_per_escalation_90d', value: 5 },
    { key: 'effort_esc_cap', value: 30 },
    { key: 'effort_per_stale_doc', value: 4 },
    { key: 'effort_doc_cap', value: 20 },
    { key: 'effort_per_overdue', value: 4 },
    { key: 'effort_overdue_cap', value: 25 },
    { key: 'effort_high_threshold', value: 70 },
    { key: 'effort_low_threshold', value: 30 },
    { key: 'sq_base', value: 100 },
    { key: 'sq_filing_gap_weight', value: 0.4 },
    { key: 'sq_sla_breach_weight', value: 60 },
    { key: 'sq_review_aging_weight', value: 2 },
    { key: 'sq_review_aging_cap', value: 15 },
    { key: 'sq_per_firm_escalation', value: 4 },
    { key: 'sq_firm_esc_cap', value: 20 },
    { key: 'risk_band_medium', value: 25 },
    { key: 'risk_band_high', value: 50 },
    { key: 'risk_band_critical', value: 75 },
    { key: 'alert_escalation_floor', value: 2 },
    { key: 'alert_escalation_ratio', value: 2 },
    { key: 'alert_repeat_delay_min', value: 3 },
    { key: 'portfolio_cold_start_min', value: 5 }
  ]
};

// Strip the provisioned-capacity settings and create on demand instead.
//
// The table definitions ask for 5 WCU / 5 RCU each, with the comment that this
// sits "well within always-free (25 WCU / 25 RCU total)". That reasoning is
// per-table, but the free allowance is per ACCOUNT — and every secondary index
// carries its own capacity too. Eighteen tables with twenty indexes between
// them came to 180 WCU and 180 RCU, seven times the allowance, which billed at
// about $102 a month. Roughly $37 of that was capacity on tables holding zero
// rows.
//
// On demand also removes the throttling: a sweep writing several hundred
// obligations at once cannot get through 5 WCU, and no amount of retrying
// fixes a rate limit. Every other BCL tool in this account is already on
// demand and they cost about $1 a month between them.
function onDemand(def) {
  const out = Object.assign({}, def, { BillingMode: 'PAY_PER_REQUEST' });
  delete out.ProvisionedThroughput;
  if (out.GlobalSecondaryIndexes) {
    out.GlobalSecondaryIndexes = out.GlobalSecondaryIndexes.map(function(g) {
      const gi = Object.assign({}, g);
      delete gi.ProvisionedThroughput;   // rejected outright in PAY_PER_REQUEST mode
      return gi;
    });
  }
  return out;
}

async function ensureTable(def) {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: def.TableName }));
    console.log('  ✓ table ' + def.TableName + ' already exists');
    return;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
  console.log('  → creating table ' + def.TableName + ' (on demand)');
  await ddb.send(new CreateTableCommand(onDemand(def)));
  await waitUntilTableExists({ client: ddb, maxWaitTime: 120 }, { TableName: def.TableName });
  console.log('  ✓ table ' + def.TableName + ' ready');
}

async function ensureBucket() {
  if (!BUCKET) {
    console.warn('  ! UCT_S3_BUCKET not set — skipping S3 bucket creation');
    return;
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log('  ✓ bucket ' + BUCKET + ' already exists');
  } catch (e) {
    console.log('  → creating bucket ' + BUCKET);
    const params = { Bucket: BUCKET };
    // us-east-1 is the default; other regions must specify a LocationConstraint.
    if (REGION !== 'us-east-1') {
      params.CreateBucketConfiguration = { LocationConstraint: REGION };
    }
    await s3.send(new CreateBucketCommand(params));
    console.log('  ✓ bucket ' + BUCKET + ' created');
  }
  // Turn on versioning — cheap insurance for the tracker_state blob.
  try {
    await s3.send(new PutBucketVersioningCommand({
      Bucket: BUCKET,
      VersioningConfiguration: { Status: 'Enabled' }
    }));
    console.log('  ✓ bucket versioning enabled');
  } catch (e) {
    console.warn('  ! bucket versioning could not be enabled:', e.message);
  }
}

async function seed(tableName, rows) {
  if (!rows || !rows.length) return;
  const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });
  // Only seed if the table is empty (idempotent — safe to re-run).
  const probe = await doc.send(new ScanCommand({ TableName: tableName, Limit: 1 }));
  if (probe.Items && probe.Items.length) {
    console.log('  ✓ ' + tableName + ' already has rows, skipping seed');
    return;
  }
  for (const row of rows) {
    await doc.send(new PutCommand({ TableName: tableName, Item: row }));
  }
  console.log('  ✓ ' + tableName + ' seeded (' + rows.length + ' row(s))');
}

async function main() {
  console.log('AWS bootstrap — region=' + REGION + ' prefix=' + PREFIX);
  console.log('');
  console.log('DynamoDB tables:');
  for (const t of TABLES) { await ensureTable(t); }
  console.log('');
  console.log('S3 bucket:');
  await ensureBucket();
  console.log('');
  console.log('Seed rows:');
  for (const [tableName, rows] of Object.entries(SEEDS)) { await seed(tableName, rows); }
  console.log('');
  console.log('Done.');
}

main().catch(function(e) {
  console.error('bootstrap failed:', e);
  process.exit(1);
});
