-- UAE Compliance Tracker — Task Engine schema (Supabase / Postgres)
-- All tables prefixed `compliance_` to share the Supabase project safely.
-- Idempotent: safe to run repeatedly.

create extension if not exists "pgcrypto";

-- =========================================================
-- Enums
-- =========================================================
do $$ begin
  create type compliance_task_status as enum (
    'not_started','waiting_documents','documents_received','in_progress',
    'ready_for_review','reviewed','completed','blocked','escalated'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_review_status as enum ('none','pending_review','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_task_type as enum (
    'Accounting_Bookkeeping','VAT_Filing','VAT_Registration','VAT_Deregistration',
    'CT_Filing','CT_Registration','CT_Deregistration','Audit','Document_Request',
    'Client_Followup','Management_Report','Review','Amendment','Refund','Other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_doc_status as enum ('pending','received','cancelled');
exception when duplicate_object then null; end $$;

-- =========================================================
-- Tasks
-- =========================================================
create table if not exists compliance_tasks (
  id                  bigserial primary key,
  client_external_id  text not null,                       -- = in-memory client.id
  client_name         text not null,                       -- denormalized snapshot
  task_type           compliance_task_type not null,
  title               text,                                -- optional short label
  description         text,
  assigned_user_id    integer,                             -- in-memory user.id (nullable = unassigned)
  assigned_user_name  text,
  status              compliance_task_status not null default 'not_started',
  review_status       compliance_review_status not null default 'none',
  reviewer_user_id    integer,
  priority_score      integer not null default 0,
  due_date            date,
  compliance_deadline date,                                -- the regulatory deadline behind this task
  created_date        timestamptz not null default now(),
  completed_date      timestamptz,
  last_status_change  timestamptz not null default now(),
  source              text not null default 'manual',      -- 'manual' | 'generator'
  source_key          text,                                -- dedupe key for generator
  metadata            jsonb not null default '{}'::jsonb,
  created_by          integer,
  updated_at          timestamptz not null default now()
);

create unique index if not exists compliance_tasks_source_key_uniq
  on compliance_tasks(source_key) where source_key is not null;

create index if not exists compliance_tasks_assigned_idx on compliance_tasks(assigned_user_id, status);
create index if not exists compliance_tasks_client_idx   on compliance_tasks(client_external_id);
create index if not exists compliance_tasks_due_idx      on compliance_tasks(due_date);
create index if not exists compliance_tasks_status_idx   on compliance_tasks(status);
create index if not exists compliance_tasks_priority_idx on compliance_tasks(priority_score desc);

-- =========================================================
-- Task comments
-- =========================================================
create table if not exists compliance_task_comments (
  id          bigserial primary key,
  task_id     bigint not null references compliance_tasks(id) on delete cascade,
  user_id     integer,
  user_name   text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists compliance_task_comments_task_idx on compliance_task_comments(task_id);

-- =========================================================
-- Document requests
-- =========================================================
create table if not exists compliance_document_requests (
  id                  bigserial primary key,
  task_id             bigint references compliance_tasks(id) on delete set null,
  client_external_id  text not null,
  client_name         text not null,
  document_name       text not null,
  notes               text,
  status              compliance_doc_status not null default 'pending',
  requested_date      timestamptz not null default now(),
  last_reminder_date  timestamptz,
  reminder_count      integer not null default 0,
  received_date       timestamptz,
  requested_by_id     integer,
  requested_by_name   text
);
create index if not exists compliance_doc_req_client_idx on compliance_document_requests(client_external_id);
create index if not exists compliance_doc_req_status_idx on compliance_document_requests(status);

-- =========================================================
-- Priority weights (configurable)
-- =========================================================
create table if not exists compliance_priority_config (
  key          text primary key,
  value        numeric not null,
  description  text,
  updated_at   timestamptz not null default now()
);

insert into compliance_priority_config(key,value,description) values
  ('overdue',                       100, 'Added when due_date < today'),
  ('due_within_7d',                  50, 'Added when 0 <= days_until_due <= 7'),
  ('compliance_deadline_within_14d', 40, 'Added when compliance_deadline within 14d'),
  ('blocked',                        30, 'Added when status = blocked'),
  ('pending_day',                     2, 'Multiplied by days since created (if not completed)'),
  ('waiting_review_over_3d',         20, 'Added when ready_for_review for > 3 days'),
  ('missing_docs_over_7d',           25, 'Added when waiting_documents > 7 days')
on conflict (key) do nothing;

-- =========================================================
-- Task generation rules
-- =========================================================
create table if not exists compliance_task_generation_rules (
  id              bigserial primary key,
  task_type       compliance_task_type not null,
  trigger_field   text not null,         -- which client field drives the deadline (e.g. 'vatDueDate','ctDueDate')
  lead_days       integer not null default 14, -- create task this many days before deadline
  recurrence      text not null default 'once', -- 'once' | 'quarterly' | 'annual' | 'monthly'
  active          boolean not null default true,
  default_title   text,
  created_at      timestamptz not null default now()
);

insert into compliance_task_generation_rules(task_type, trigger_field, lead_days, recurrence, default_title) values
  ('VAT_Filing',   'vatDueDate', 21, 'quarterly', 'VAT Filing'),
  ('CT_Filing',    'ctDueDate',  30, 'annual',    'Corporate Tax Filing'),
  ('VAT_Registration',   'vatRegistrationDue', 14, 'once', 'VAT Registration'),
  ('CT_Registration',    'ctRegistrationDue',  14, 'once', 'CT Registration'),
  ('Audit',              'auditDueDate',       30, 'annual', 'Annual Audit'),
  ('Management_Report',  'reportingDate',       7, 'monthly', 'Management Report')
on conflict do nothing;
