// Repository layer — provider-agnostic data access facade.
//
// Phase 3 architecture: Services depend only on this module. The current
// implementation routes Postgres-shaped reads through compliance.js /
// obligations.js (which today wrap @supabase/supabase-js, but the calls are
// plain SQL-style queries — replaceable with raw pg, an AWS RDS driver, or
// DynamoDB by reimplementing this file. Method signatures and return shapes
// are stable.
//
// Two repositories live in-memory today (UsersRepo, ClientsRepo) because the
// upstream app keeps users/clients in process. Same swap pattern applies.
//
// NEVER import @supabase/supabase-js from a service. Always go through here.

const compliance = require('../compliance');
const { obligations: oblData } = require('../obligations');
const { users: usersStore, tracker, store, activity } = require('../database');
const { getClient } = require('../supabase');
const { WorkflowsRepo, WorkflowStepsRepo } = require('./workflowsRepo');
const { ClientSettingsRepo } = require('./clientSettingsRepo');

function pg() {
  const c = getClient();
  if (!c) throw new Error('Storage backend not configured');
  return c;
}

// -------------------- TasksRepo --------------------
const TasksRepo = {
  listAll(filter = {}) { return compliance.tasks.list(filter); },
  listOpen(filter = {}) { return compliance.tasks.list(Object.assign({ notStatus: ['completed'] }, filter)); },
  listByAssignee(userId, filter = {}) { return compliance.tasks.list(Object.assign({ assignedUserId: userId }, filter)); },
  listByClient(clientId, filter = {}) { return compliance.tasks.list(Object.assign({ clientId }, filter)); },
  listAwaitingReview(filter = {}) { return compliance.tasks.list(Object.assign({ status: 'ready_for_review' }, filter)); },
  listCompletedBetween(fromISO, toISO) {
    // No specific predicate in compliance.tasks.list — fetch and filter.
    return compliance.tasks.list({ status: 'completed', limit: 5000 }).then(rows =>
      rows.filter(t => t.completed_date && t.completed_date >= fromISO && t.completed_date <= toISO));
  },
  getById(id) { return compliance.tasks.getById(id); },
  update(id, patch) { return compliance.tasks.update(id, patch); },
  setStatus(id, status, extra) { return compliance.tasks.setStatus(id, status, extra); },
  setSubmittedForReview(id, at) {
    return compliance.tasks.update(id, { submitted_for_review_at: at || new Date().toISOString() });
  }
};

// -------------------- ObligationsRepo --------------------
const ObligationsRepo = {
  list(filter = {}) { return oblData.list(filter); },
  listBetween(fromISO, toISO, clientId) {
    return oblData.list({ from: fromISO, to: toISO, clientId, limit: 5000 });
  }
};

// -------------------- DocumentsRepo --------------------
const DocumentsRepo = {
  listPending() { return compliance.documents.list({ status: 'pending', limit: 5000 }); },
  listForClient(clientId) { return compliance.documents.list({ clientId, limit: 1000 }); }
};

// -------------------- CommentsRepo --------------------
const CommentsRepo = {
  listForTask(taskId) { return compliance.comments.listForTask(taskId); },
  // Lightweight last-comment lookup across many tasks. Single round-trip.
  async lastCommentByTask(taskIds) {
    if (!taskIds || !taskIds.length) return {};
    const { data, error } = await pg().from('compliance_task_comments')
      .select('task_id, created_at, user_name')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { if (!map[r.task_id]) map[r.task_id] = r; });
    return map;
  }
};

// -------------------- ReviewEventsRepo --------------------
const ReviewEventsRepo = {
  async create(evt) {
    const row = {
      task_id: evt.taskId,
      submitted_at: evt.submittedAt || null,
      reviewed_at: evt.reviewedAt || new Date().toISOString(),
      reviewer_user_id: evt.reviewerUserId || null,
      reviewer_user_name: evt.reviewerUserName || null,
      decision: evt.decision,
      turnaround_seconds: evt.turnaroundSeconds || null,
      notes: evt.notes || null
    };
    const { data, error } = await pg().from('compliance_review_events').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },
  async listBetween(fromISO, toISO) {
    const { data, error } = await pg().from('compliance_review_events')
      .select('*').gte('reviewed_at', fromISO).lte('reviewed_at', toISO).order('reviewed_at', { ascending: false }).limit(5000);
    if (error) throw error;
    return data || [];
  }
};

// -------------------- EscalationEventsRepo --------------------
const EscalationEventsRepo = {
  async listBetween(fromISO, toISO) {
    const { data, error } = await pg().from('compliance_escalation_events')
      .select('*').gte('triggered_at', fromISO).lte('triggered_at', toISO).order('triggered_at', { ascending: false }).limit(5000);
    if (error) throw error;
    return data || [];
  },
  async listOpen() {
    const { data, error } = await pg().from('compliance_escalation_events')
      .select('*').is('resolved_at', null).order('triggered_at', { ascending: true }).limit(500);
    if (error) throw error;
    return data || [];
  }
};

// -------------------- WorkloadConfigRepo --------------------
const WorkloadConfigRepo = {
  async getAll() {
    const { data, error } = await pg().from('compliance_workload_config').select('*');
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[r.key] = Number(r.value); });
    return Object.assign({
      default_capacity_open_tasks: 20,
      band_underutilized_max: 0.6,
      band_overloaded_min: 1.1,
      forecast_days: 30,
      communication_silence_days: 14,
      review_aging_warn_days: 3,
      review_aging_alarm_days: 7
    }, map);
  },
  async set(key, value) {
    const { error } = await pg().from('compliance_workload_config')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
  }
};

// -------------------- UserCapacityRepo --------------------
const UserCapacityRepo = {
  async getAll() {
    const { data, error } = await pg().from('compliance_user_capacity').select('*');
    if (error) throw error;
    return data || [];
  },
  async getForUser(userId) {
    const { data } = await pg().from('compliance_user_capacity').select('*').eq('user_id', userId).maybeSingle();
    return data;
  },
  async setForUser(userId, payload) {
    const row = Object.assign({ user_id: userId, updated_at: new Date().toISOString() }, payload);
    const { data, error } = await pg().from('compliance_user_capacity')
      .upsert(row, { onConflict: 'user_id' }).select('*').single();
    if (error) throw error;
    return data;
  }
};

// -------------------- UsersRepo (in-memory) --------------------
const UsersRepo = {
  listActive() { return (store.users || []).filter(u => u.active === 1).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })); },
  listAdmins() { return (store.users || []).filter(u => u.active === 1 && u.role === 'admin'); },
  findByName(name) { return (store.users || []).find(u => u.name === name && u.active === 1) || null; },
  findById(id) { return usersStore.findById(id); }
};

// -------------------- ClientsRepo (in-memory) --------------------
const ClientsRepo = {
  listAll() { return (tracker.getData().clients || []); },
  findById(id) { return (tracker.getData().clients || []).find(c => String(c.id) === String(id)) || null; },
  listForAssignee(userName) { return (tracker.getData().clients || []).filter(c => c.assignedTeam === userName); }
};

// -------------------- ActivityRepo --------------------
const ActivityRepo = {
  listRecent(limit) { return activity.getRecent(limit); },
  log(userId, userName, action, details) { return activity.log(userId, userName, action, details); }
};

module.exports = {
  TasksRepo, ObligationsRepo, DocumentsRepo, CommentsRepo,
  ReviewEventsRepo, EscalationEventsRepo,
  WorkloadConfigRepo, UserCapacityRepo,
  UsersRepo, ClientsRepo, ActivityRepo,
  WorkflowsRepo, WorkflowStepsRepo,
  ClientSettingsRepo
};
