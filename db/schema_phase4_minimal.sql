-- Phase 4 (MINIMAL) — workflow state machine for filing readiness.
-- Just enough to power Phase 5's "Client Confirmation Pending" and
-- "Ready For Filing / Partially Ready / Not Ready" detection.
-- Full Phase 4 (onboarding checklists, registrations, doc verification,
-- audit log) intentionally deferred. Idempotent.

do $$ begin
  create type compliance_workflow_type as enum (
    'VAT_Filing','CT_Filing','Accounting','VAT_Registration','CT_Registration','Onboarding'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_workflow_status as enum ('active','paused','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_step_status as enum ('locked','pending','in_progress','completed','skipped');
exception when duplicate_object then null; end $$;

-- Workflow instance: one per (client, type, period).
create table if not exists compliance_workflows (
  id                  bigserial primary key,
  client_external_id  text not null,
  client_name         text not null,
  workflow_type       compliance_workflow_type not null,
  period_label        text,
  obligation_id       bigint references compliance_obligations(id) on delete set null,
  task_id             bigint references compliance_tasks(id)       on delete set null,
  current_step_key    text,
  status              compliance_workflow_status not null default 'active',
  source_key          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists compliance_workflows_source_key_uniq on compliance_workflows(source_key);
create index if not exists compliance_workflows_client_idx on compliance_workflows(client_external_id);
create index if not exists compliance_workflows_type_idx   on compliance_workflows(workflow_type, status);

-- Ordered steps within a workflow. Only one step is in_progress at a time;
-- the rest are locked → pending → completed.
create table if not exists compliance_workflow_steps (
  id                  bigserial primary key,
  workflow_id         bigint not null references compliance_workflows(id) on delete cascade,
  step_order          integer not null,
  step_key            text not null,
  step_label          text not null,
  status              compliance_step_status not null default 'locked',
  responsible_user_id integer,
  responsible_user_name text,
  reviewer_user_id    integer,
  completed_at        timestamptz,
  completed_by_id     integer,
  completed_by_name   text,
  filing_date         date,
  notes               text,
  unique (workflow_id, step_key)
);
create index if not exists compliance_workflow_steps_workflow_idx on compliance_workflow_steps(workflow_id, step_order);

-- Phase 5 — add risk-engine threshold knobs to workload_config (no new tables).
insert into compliance_workload_config(key,value,description) values
  ('risk_no_activity_medium_days', 5,  'Days without task activity → medium risk'),
  ('risk_no_activity_high_days',   10, 'Days without task activity → high risk'),
  ('risk_overdue_critical_days',   7,  'Days overdue → critical risk'),
  ('risk_docs_pending_medium',     7,  'Days a doc has been pending → medium risk'),
  ('risk_docs_pending_high',       14, 'Days a doc has been pending → high risk'),
  ('risk_registration_high_days',  30, 'Days a registration has been pending → high risk'),
  ('risk_review_high_days',        7,  'Days a review has been pending → high risk'),
  ('risk_deadline_critical_days',  2,  'Days to deadline triggering critical when not in_progress'),
  ('risk_deadline_high_days',      7,  'Days to deadline triggering high'),
  ('client_score_band_amber',      16, 'Client escalation score ≥ this → amber'),
  ('client_score_band_red',        40, 'Client escalation score ≥ this → red'),
  ('client_score_critical_weight', 25, 'Score weight for critical findings'),
  ('client_score_high_weight',     10, 'Score weight for high findings'),
  ('client_score_medium_weight',    3, 'Score weight for medium findings'),
  ('client_score_low_weight',       1, 'Score weight for low findings'),
  ('bottleneck_min_items',          3, 'Minimum stuck items for a bottleneck alert')
on conflict (key) do nothing;
