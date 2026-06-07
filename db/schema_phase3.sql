-- UAE Compliance Tracker — Phase 3 schema (operations management)
-- Idempotent. Run AFTER schema.sql and schema_phase2.sql.
-- Notes: kept minimal. Phase 3 is mostly aggregation over existing tables.

-- =========================================================
-- ALTER compliance_tasks
-- =========================================================
alter table compliance_tasks add column if not exists submitted_for_review_at timestamptz;
create index if not exists compliance_tasks_submitted_review_idx
  on compliance_tasks(submitted_for_review_at) where submitted_for_review_at is not null;

-- =========================================================
-- Review events (append-only audit log of review decisions)
-- =========================================================
create table if not exists compliance_review_events (
  id                 bigserial primary key,
  task_id            bigint not null references compliance_tasks(id) on delete cascade,
  submitted_at       timestamptz,
  reviewed_at        timestamptz not null default now(),
  reviewer_user_id   integer,
  reviewer_user_name text,
  decision           text not null,  -- 'approve' | 'reject'
  turnaround_seconds integer,
  notes              text
);
create index if not exists compliance_review_events_task_idx     on compliance_review_events(task_id);
create index if not exists compliance_review_events_reviewer_idx on compliance_review_events(reviewer_user_id);
create index if not exists compliance_review_events_time_idx     on compliance_review_events(reviewed_at desc);

-- =========================================================
-- Workload configuration (thresholds + default capacity)
-- =========================================================
create table if not exists compliance_workload_config (
  key         text primary key,
  value       numeric not null,
  description text,
  updated_at  timestamptz not null default now()
);

insert into compliance_workload_config(key,value,description) values
  ('default_capacity_open_tasks', 20, 'Default open-task capacity per user'),
  ('band_underutilized_max',     0.60, 'Ratio <= this is underutilized'),
  ('band_overloaded_min',        1.10, 'Ratio >= this is overloaded'),
  ('forecast_days',              30,   'Default forecast horizon (days)'),
  ('communication_silence_days', 14,   'Default "no contact" threshold for client comms tracker'),
  ('review_aging_warn_days',     3,    'Reviews older than this trigger amber'),
  ('review_aging_alarm_days',    7,    'Reviews older than this trigger red')
on conflict (key) do nothing;

-- =========================================================
-- Per-user capacity overrides (sparse — only rows for non-default users)
-- =========================================================
create table if not exists compliance_user_capacity (
  user_id                     integer primary key,
  user_name                   text,
  capacity_open_tasks         integer,
  capacity_weekly_completions integer,
  notes                       text,
  updated_at                  timestamptz not null default now()
);
