-- Phase 7 — Client Portfolio Management & Service Governance.
-- One small table for admin-set client metadata + config rows for tier
-- multipliers and portfolio score weights. Idempotent.

create table if not exists compliance_client_settings (
  client_external_id  text primary key,
  tier                text not null default 'B',  -- 'A' | 'B' | 'C'
  partner_owner       text,
  notes               text,
  override_reason     text,                       -- free-text justification for tier
  updated_by_id       integer,
  updated_by_name     text,
  updated_at          timestamptz not null default now()
);

-- Append tier + score-weight knobs to workload_config. Defaults set per Phase 7
-- spec: tier A multiplier 1.5 (stand out clearly), B 1.0, C 0.75.
insert into compliance_workload_config(key,value,description) values
  ('tier_a_multiplier',         1.50, 'Priority multiplier for Tier A clients'),
  ('tier_b_multiplier',         1.00, 'Priority multiplier for Tier B clients'),
  ('tier_c_multiplier',         0.75, 'Priority multiplier for Tier C clients'),

  -- Responsiveness score weights
  ('resp_base',                 100,  'Starting responsiveness score'),
  ('resp_per_stale_doc',          8,  'Deduction per stale doc (>7d)'),
  ('resp_stale_doc_cap',         40,  'Max deduction from stale docs'),
  ('resp_per_waiting_docs_14d',  10,  'Deduction per task waiting_documents >14d'),
  ('resp_waiting_docs_cap',      30,  'Max deduction from waiting_documents'),
  ('resp_per_missed_confirm',    15,  'Deduction per missed confirmation (>7d)'),
  ('resp_missed_confirm_cap',    45,  'Max deduction from missed confirmations'),
  ('resp_per_reminder',           2,  'Deduction per reminder on still-pending doc'),
  ('resp_reminder_cap',          20,  'Max deduction from reminders'),
  ('resp_recent_response_bonus',  5,  'Bonus if any doc received in last 14d'),

  -- Effort score weights (higher = more effort required by firm)
  ('effort_per_open_task',      1.5,  'Effort points per open task'),
  ('effort_open_cap',            40,  'Max effort from open tasks'),
  ('effort_per_escalation_90d',   5,  'Effort points per escalation last 90d'),
  ('effort_esc_cap',             30,  'Max effort from escalations'),
  ('effort_per_stale_doc',        4,  'Effort points per stale doc'),
  ('effort_doc_cap',             20,  'Max effort from stale docs'),
  ('effort_per_overdue',          4,  'Effort points per overdue task'),
  ('effort_overdue_cap',         25,  'Max effort from overdue'),
  ('effort_high_threshold',      70,  'Score ≥ this → high-maintenance'),
  ('effort_low_threshold',       30,  'Score ≤ this → low-maintenance'),

  -- Service quality (firm-side performance)
  ('sq_base',                   100,  'Starting service-quality score'),
  ('sq_filing_gap_weight',      0.4,  'Weight applied to (100 - filing_timeliness_pct)'),
  ('sq_sla_breach_weight',       60,  'Weight applied to SLA breach rate'),
  ('sq_review_aging_weight',      2,  'Weight applied to avg review aging days'),
  ('sq_review_aging_cap',        15,  'Max deduction from review aging'),
  ('sq_per_firm_escalation',      4,  'Deduction per firm-attributed escalation'),
  ('sq_firm_esc_cap',            20,  'Max deduction from firm escalations'),

  -- Risk profile bands (composite overall risk)
  ('risk_band_medium',           25,  'Overall risk ≥ this → Medium'),
  ('risk_band_high',             50,  'Overall risk ≥ this → High'),
  ('risk_band_critical',         75,  'Overall risk ≥ this → Critical'),

  -- Key Client Alerts thresholds
  ('alert_escalation_floor',      2,  'Absolute floor for increasing-escalations alert'),
  ('alert_escalation_ratio',      2,  'Current/previous ratio for escalation alert'),
  ('alert_repeat_delay_min',      3,  'Min SLA breaches in 90d for repeated-delay alert'),

  -- Sample-size cold-start
  ('portfolio_cold_start_min',    5,  'Below this event count, return confidence=low')
on conflict (key) do nothing;
