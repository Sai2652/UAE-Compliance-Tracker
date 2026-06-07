-- UAE Compliance Tracker — Phase 2 schema (intelligence, obligations, SLA, escalations, health)
-- Idempotent. Run AFTER schema.sql.

-- =========================================================
-- Enums
-- =========================================================
do $$ begin
  create type compliance_obligation_type as enum (
    'VAT_Return','CT_Return','VAT_Registration','CT_Registration',
    'VAT_Amendment','CT_Amendment','VAT_Refund','CT_Refund',
    'Audit','Management_Report','Review'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_obligation_status as enum (
    'upcoming','active','filed','overdue','waived'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_sla_status as enum (
    'on_track','at_risk','likely_breach','breached','met'
  );
exception when duplicate_object then null; end $$;

-- =========================================================
-- Obligations — the regulatory calendar
-- =========================================================
create table if not exists compliance_obligations (
  id                   bigserial primary key,
  client_external_id   text not null,
  client_name          text not null,
  obligation_type      compliance_obligation_type not null,
  period_label         text not null,          -- '2026-Q2', 'FY2025', etc.
  period_start         date,
  period_end           date,
  filing_deadline      date not null,
  payment_deadline     date,
  status               compliance_obligation_status not null default 'upcoming',
  source_key           text not null,          -- gen:<client>:<type>:<period>
  metadata             jsonb not null default '{}'::jsonb,
  filed_at             timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists compliance_obligations_source_key_uniq
  on compliance_obligations(source_key);
create index if not exists compliance_obligations_client_idx   on compliance_obligations(client_external_id);
create index if not exists compliance_obligations_deadline_idx on compliance_obligations(filing_deadline);
create index if not exists compliance_obligations_status_idx   on compliance_obligations(status);

-- =========================================================
-- Extend compliance_tasks (additive)
-- =========================================================
alter table compliance_tasks add column if not exists obligation_id          bigint references compliance_obligations(id) on delete set null;
alter table compliance_tasks add column if not exists target_start_date      date;
alter table compliance_tasks add column if not exists target_completion_date date;
alter table compliance_tasks add column if not exists sla_status             compliance_sla_status not null default 'on_track';
alter table compliance_tasks add column if not exists escalation_level       integer not null default 0;
alter table compliance_tasks add column if not exists last_escalated_at      timestamptz;
alter table compliance_tasks add column if not exists last_activity_at       timestamptz not null default now();

create index if not exists compliance_tasks_obligation_idx on compliance_tasks(obligation_id);
create index if not exists compliance_tasks_sla_idx        on compliance_tasks(sla_status);

-- =========================================================
-- SLA policies (per task type)
-- =========================================================
create table if not exists compliance_sla_policies (
  task_type                    compliance_task_type primary key,
  target_lead_days_start       integer not null default 14,  -- days before deadline work should start
  target_lead_days_complete    integer not null default 3,   -- days before deadline work should be done
  at_risk_threshold_days       integer not null default 7,
  breach_threshold_days        integer not null default 0,
  updated_at                   timestamptz not null default now()
);

insert into compliance_sla_policies(task_type, target_lead_days_start, target_lead_days_complete, at_risk_threshold_days, breach_threshold_days) values
  ('VAT_Filing',          21, 5, 7, 0),
  ('CT_Filing',           45, 7, 14, 0),
  ('VAT_Registration',    14, 2, 5, 0),
  ('VAT_Deregistration',  14, 2, 5, 0),
  ('CT_Registration',     14, 2, 5, 0),
  ('CT_Deregistration',   14, 2, 5, 0),
  ('Audit',               30, 5, 14, 0),
  ('Accounting_Bookkeeping', 7, 1, 3, 0),
  ('Management_Report',   7, 1, 3, 0),
  ('Document_Request',    3, 0, 2, 0),
  ('Review',              3, 0, 2, 0),
  ('Amendment',           7, 1, 3, 0),
  ('Refund',              14, 2, 5, 0),
  ('Client_Followup',     2, 0, 1, 0),
  ('Other',               7, 1, 3, 0)
on conflict (task_type) do nothing;

-- =========================================================
-- Escalation rules
-- =========================================================
create table if not exists compliance_escalation_rules (
  id              bigserial primary key,
  name            text not null,
  condition_type  text not null,           -- no_updates|docs_pending|review_backlog|not_started|deadline_approaching
  threshold_days  integer not null,
  severity        integer not null default 1, -- 1=flag, 2=escalate, 3=urgent
  notify_owner    boolean not null default true,
  notify_admin    boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

insert into compliance_escalation_rules(name, condition_type, threshold_days, severity, notify_owner, notify_admin) values
  ('No activity 5 days',            'no_updates',          5, 1, true,  false),
  ('No activity 10 days',           'no_updates',         10, 2, true,  true),
  ('Documents pending 7 days',      'docs_pending',        7, 1, true,  false),
  ('Documents pending 14 days',     'docs_pending',       14, 2, true,  true),
  ('Awaiting review 3 days',        'review_backlog',      3, 1, false, true),
  ('Awaiting review 7 days',        'review_backlog',      7, 2, false, true),
  ('Not started within 7d of due',  'not_started',         7, 2, true,  true),
  ('Deadline within 3 days',        'deadline_approaching',3, 2, true,  true),
  ('Deadline within 1 day',         'deadline_approaching',1, 3, true,  true)
on conflict do nothing;

-- =========================================================
-- Escalation events (audit log)
-- =========================================================
create table if not exists compliance_escalation_events (
  id            bigserial primary key,
  task_id       bigint not null references compliance_tasks(id) on delete cascade,
  rule_id       bigint references compliance_escalation_rules(id) on delete set null,
  rule_name     text,
  severity      integer not null default 1,
  triggered_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  notes         text,
  notified      text[] not null default '{}'::text[]
);
create index if not exists compliance_escalation_events_task_idx on compliance_escalation_events(task_id);
create index if not exists compliance_escalation_events_open_idx on compliance_escalation_events(task_id) where resolved_at is null;

-- =========================================================
-- Health score weights (configurable)
-- =========================================================
create table if not exists compliance_health_weights (
  key         text primary key,
  value       numeric not null,
  description text,
  updated_at  timestamptz not null default now()
);

insert into compliance_health_weights(key,value,description) values
  ('base_score',                100, 'Starting score before deductions'),
  ('overdue_per_task',           15, 'Deduction per overdue task'),
  ('overdue_cap',                40, 'Max deduction from overdue'),
  ('blocked_per_task',           10, 'Deduction per blocked/escalated task'),
  ('blocked_cap',                25, 'Max deduction from blocked'),
  ('doc_pending_over_7d',         5, 'Deduction per doc pending >7d'),
  ('review_pending_over_3d',      5, 'Deduction per task in review >3d'),
  ('unstarted_deadline_within_7d',10, 'Deduction if any obligation due <=7d unstarted'),
  ('recent_activity_bonus',       5, 'Added if activity in last 3 days'),
  ('band_healthy',               80, 'Score >= this is healthy'),
  ('band_watch',                 60, 'Score >= this is watch'),
  ('band_at_risk',               40, 'Score >= this is at-risk; below is critical')
on conflict (key) do nothing;

-- =========================================================
-- Update trigger to maintain last_activity_at on tasks
-- =========================================================
create or replace function compliance_tasks_touch_activity() returns trigger as $$
begin
  if new.status is distinct from old.status
     or new.assigned_user_id is distinct from old.assigned_user_id
     or new.description is distinct from old.description then
    new.last_activity_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists compliance_tasks_touch_activity_trg on compliance_tasks;
create trigger compliance_tasks_touch_activity_trg
  before update on compliance_tasks
  for each row execute function compliance_tasks_touch_activity();
