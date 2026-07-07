// Repository layer — DynamoDB-backed (migrated from Supabase in Sessions 1-3).
// Services depend only on this module. NEVER import @aws-sdk from a service.

const compliance = require('../compliance');
const { obligations: oblData } = require('../obligations');
const { users: usersStore, tracker, store, activity } = require('../database');
const { getDdb, tableName } = require('../aws');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, ScanCommand
} = require('@aws-sdk/lib-dynamodb');
const { WorkflowsRepo, WorkflowStepsRepo } = require('./workflowsRepo');
const { ClientSettingsRepo } = require('./clientSettingsRepo');

function ddb() { const c = getDdb(); if (!c) throw new Error('DynamoDB not configured'); return c; }
function tbl(suffix) { return tableName(suffix); }

let _lastId = 0;
function newId() {
  const t = Date.now();
  if (t <= _lastId) _lastId = _lastId + 1; else _lastId = t;
  return _lastId;
}

async function scanAll(table) {
  const c = ddb(); const items = []; let ExclusiveStartKey;
  do {
    const out = await c.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    if (out.Items) items.push.apply(items, out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function buildUpdate(patch) {
  const setParts = [], removeParts = [], names = {}, values = {};
  Object.keys(patch).forEach(function(k, i) {
    const nk = '#f' + i; names[nk] = k;
    const v = patch[k];
    if (v === null || typeof v === 'undefined') removeParts.push(nk);
    else { const nv = ':v' + i; values[nv] = v; setParts.push(nk + ' = ' + nv); }
  });
  const parts = [];
  if (setParts.length) parts.push('SET ' + setParts.join(', '));
  if (removeParts.length) parts.push('REMOVE ' + removeParts.join(', '));
  const out = { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names };
  if (Object.keys(values).length) out.ExpressionAttributeValues = values;
  return out;
}

// -------------------- TasksRepo --------------------
const TasksRepo = {
  listAll(filter = {}) { return compliance.tasks.list(filter); },
  listOpen(filter = {}) { return compliance.tasks.list(Object.assign({ notStatus: ['completed'] }, filter)); },
  listByAssignee(userId, filter = {}) { return compliance.tasks.list(Object.assign({ assignedUserId: userId }, filter)); },
  listByClient(clientId, filter = {}) { return compliance.tasks.list(Object.assign({ clientId }, filter)); },
  listAwaitingReview(filter = {}) { return compliance.tasks.list(Object.assign({ status: 'ready_for_review' }, filter)); },
  listCompletedBetween(fromISO, toISO) {
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
  async lastCommentByTask(taskIds) {
    if (!taskIds || !taskIds.length) return {};
    const c = ddb();
    const table = tbl('TaskComments');
    const results = await Promise.all(taskIds.map(function(id) {
      return c.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'task_id' },
        ExpressionAttributeValues: { ':t': Number(id) },
        ScanIndexForward: false,
        Limit: 1,
        ProjectionExpression: 'task_id, created_at, user_name'
      })).then(function(out) { return (out.Items && out.Items[0]) || null; })
        .catch(function(e) { console.warn('[CommentsRepo.lastCommentByTask]', id, e.message); return null; });
    }));
    const map = {};
    results.forEach(function(r) { if (r) map[r.task_id] = r; });
    return map;
  }
};

// -------------------- ReviewEventsRepo --------------------
const REVIEW_PARTITION = 'GLOBAL';
const ReviewEventsRepo = {
  async create(evt) {
    const item = {
      id: newId(),
      partition: REVIEW_PARTITION,
      task_id: Number(evt.taskId),
      submitted_at: evt.submittedAt || undefined,
      reviewed_at: evt.reviewedAt || new Date().toISOString(),
      reviewer_user_id: evt.reviewerUserId != null ? Number(evt.reviewerUserId) : undefined,
      reviewer_user_name: evt.reviewerUserName || undefined,
      decision: evt.decision,
      turnaround_seconds: evt.turnaroundSeconds != null ? Number(evt.turnaroundSeconds) : undefined,
      notes: evt.notes || undefined
    };
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tbl('ReviewEvents'), Item: item }));
    return item;
  },

  async listBetween(fromISO, toISO) {
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('ReviewEvents'),
      IndexName: 'time-index',
      KeyConditionExpression: '#p = :p AND #t BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#p': 'partition', '#t': 'reviewed_at' },
      ExpressionAttributeValues: { ':p': REVIEW_PARTITION, ':from': fromISO, ':to': toISO },
      ScanIndexForward: false,
      Limit: 5000
    }));
    return out.Items || [];
  },

  // Used by portfolio timeline — fetch review events for a set of task ids.
  async listForTasks(taskIds) {
    if (!taskIds || !taskIds.length) return [];
    const c = ddb();
    const results = await Promise.all(taskIds.map(function(id) {
      return c.send(new QueryCommand({
        TableName: tbl('ReviewEvents'),
        IndexName: 'task-index',
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'task_id' },
        ExpressionAttributeValues: { ':t': Number(id) },
        ScanIndexForward: false
      })).then(function(out) { return out.Items || []; }).catch(function() { return []; });
    }));
    const flat = [].concat.apply([], results);
    flat.sort(function(a, b) { return String(b.reviewed_at || '').localeCompare(String(a.reviewed_at || '')); });
    return flat.slice(0, 500);
  }
};

// -------------------- EscalationEventsRepo --------------------
const ESC_PARTITION = 'GLOBAL';
const EscalationEventsRepo = {
  async create(evt) {
    const item = {
      id: newId(),
      partition: ESC_PARTITION,
      task_id: Number(evt.task_id),
      rule_id: evt.rule_id != null ? Number(evt.rule_id) : undefined,
      rule_name: evt.rule_name || undefined,
      severity: evt.severity != null ? Number(evt.severity) : 1,
      triggered_at: evt.triggered_at || new Date().toISOString(),
      resolved_at: evt.resolved_at || undefined,
      open_partition: evt.resolved_at ? undefined : 'OPEN',  // sparse — open events only
      notified: evt.notified || [],
      notes: evt.notes || undefined
    };
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tbl('EscalationEvents'), Item: item }));
    return item;
  },

  async resolve(id) {
    const upd = buildUpdate({ resolved_at: new Date().toISOString(), open_partition: null });
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tbl('EscalationEvents'),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  },

  async listBetween(fromISO, toISO) {
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('EscalationEvents'),
      IndexName: 'time-index',
      KeyConditionExpression: '#p = :p AND #t BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#p': 'partition', '#t': 'triggered_at' },
      ExpressionAttributeValues: { ':p': ESC_PARTITION, ':from': fromISO, ':to': toISO },
      ScanIndexForward: false,
      Limit: 5000
    }));
    return out.Items || [];
  },

  async listOpen() {
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('EscalationEvents'),
      IndexName: 'open-index',
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'open_partition' },
      ExpressionAttributeValues: { ':p': 'OPEN' },
      ScanIndexForward: true,
      Limit: 500
    }));
    return out.Items || [];
  },

  async listRecent(limit) {
    const n = Math.min(Math.max(parseInt(limit || 100, 10) || 100, 1), 1000);
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('EscalationEvents'),
      IndexName: 'time-index',
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'partition' },
      ExpressionAttributeValues: { ':p': ESC_PARTITION },
      ScanIndexForward: false,
      Limit: n
    }));
    return out.Items || [];
  },

  async listForTasks(taskIds) {
    if (!taskIds || !taskIds.length) return [];
    const c = ddb();
    const results = await Promise.all(taskIds.map(function(id) {
      return c.send(new QueryCommand({
        TableName: tbl('EscalationEvents'),
        IndexName: 'task-index',
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'task_id' },
        ExpressionAttributeValues: { ':t': Number(id) },
        ScanIndexForward: false
      })).then(function(out) { return out.Items || []; }).catch(function() { return []; });
    }));
    const flat = [].concat.apply([], results);
    flat.sort(function(a, b) { return String(b.triggered_at || '').localeCompare(String(a.triggered_at || '')); });
    return flat.slice(0, 500);
  },

  async hasOpenFor(taskId, ruleId) {
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('EscalationEvents'),
      IndexName: 'task-index',
      KeyConditionExpression: '#t = :t',
      FilterExpression: 'attribute_exists(open_partition) AND #r = :r',
      ExpressionAttributeNames: { '#t': 'task_id', '#r': 'rule_id' },
      ExpressionAttributeValues: { ':t': Number(taskId), ':r': Number(ruleId) },
      Limit: 1
    }));
    return (out.Items || []).length > 0;
  }
};

// -------------------- WorkloadConfigRepo --------------------
const WorkloadConfigRepo = {
  async getAll() {
    const items = await scanAll(tbl('WorkloadConfig'));
    const map = {};
    items.forEach(function(r) { map[r.key] = Number(r.value); });
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
    await ddb().send(new PutCommand({
      TableName: tbl('WorkloadConfig'),
      Item: { key: String(key), value: Number(value), updated_at: new Date().toISOString() }
    }));
  }
};

// -------------------- UserCapacityRepo --------------------
const UserCapacityRepo = {
  async getAll() { return scanAll(tbl('UserCapacity')); },
  async getForUser(userId) {
    const out = await ddb().send(new GetCommand({ TableName: tbl('UserCapacity'), Key: { user_id: Number(userId) } }));
    return out.Item || null;
  },
  async setForUser(userId, payload) {
    const existing = (await this.getForUser(userId)) || {};
    const item = Object.assign({}, existing, payload || {}, {
      user_id: Number(userId),
      updated_at: new Date().toISOString()
    });
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tbl('UserCapacity'), Item: item }));
    return item;
  }
};

// -------------------- EscalationRulesRepo (new) --------------------
const EscalationRulesRepo = {
  async listAll() {
    const items = await scanAll(tbl('EscalationRules'));
    return items.sort(function(a, b) { return Number(a.id) - Number(b.id); });
  },
  async listActive() {
    const items = await this.listAll();
    return items.filter(function(r) { return r.active === true; });
  },
  async update(id, patch) {
    const upd = buildUpdate(patch);
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tbl('EscalationRules'),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  }
};

// -------------------- SlaPoliciesRepo (new) --------------------
const SlaPoliciesRepo = {
  async getAll() {
    const items = await scanAll(tbl('SlaPolicies'));
    const map = {};
    items.forEach(function(p) { map[p.task_type] = p; });
    return map;
  },
  async listAll() {
    const items = await scanAll(tbl('SlaPolicies'));
    return items.sort(function(a, b) { return String(a.task_type).localeCompare(String(b.task_type)); });
  },
  async upsert(taskType, patch) {
    const existing = await ddb().send(new GetCommand({ TableName: tbl('SlaPolicies'), Key: { task_type: String(taskType) } }));
    const item = Object.assign({ task_type: String(taskType) }, existing.Item || {}, patch || {}, { updated_at: new Date().toISOString() });
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tbl('SlaPolicies'), Item: item }));
    return item;
  }
};

// -------------------- HealthWeightsRepo (new) --------------------
const HealthWeightsRepo = {
  async getAll() {
    const items = await scanAll(tbl('HealthWeights'));
    const map = {};
    items.forEach(function(r) { map[r.key] = Number(r.value); });
    return map;
  },
  async set(key, value) {
    await ddb().send(new PutCommand({
      TableName: tbl('HealthWeights'),
      Item: { key: String(key), value: Number(value), updated_at: new Date().toISOString() }
    }));
  }
};

// -------------------- PriorityConfigRepo (new) --------------------
const PriorityConfigRepo = {
  async getAll() {
    const items = await scanAll(tbl('PriorityConfig'));
    const map = {};
    items.forEach(function(r) { map[r.key] = Number(r.value); });
    return map;
  },
  async set(key, value) {
    await ddb().send(new PutCommand({
      TableName: tbl('PriorityConfig'),
      Item: { key: String(key), value: Number(value), updated_at: new Date().toISOString() }
    }));
  }
};

// -------------------- UsersRepo (in-memory cache, Supabase-hydrated) --------------------
const UsersRepo = {
  listActive() { return (store.users || []).filter(u => u.active === 1).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })); },
  listAdmins() { return (store.users || []).filter(u => u.active === 1 && u.role === 'admin'); },
  findByName(name) { return (store.users || []).find(u => u.name === name && u.active === 1) || null; },
  findById(id) { return usersStore.findById(id); }
};

// -------------------- ClientsRepo (in-memory cache, S3-hydrated) --------------------
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
  EscalationRulesRepo, SlaPoliciesRepo, HealthWeightsRepo, PriorityConfigRepo,
  UsersRepo, ClientsRepo, ActivityRepo,
  WorkflowsRepo, WorkflowStepsRepo,
  ClientSettingsRepo
};
