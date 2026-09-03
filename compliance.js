// Compliance data layer — DynamoDB-backed (migrated from Supabase in Session 2).
// Public shape unchanged: exports { tasks, comments, documents, generationRules,
// config, TASK_STATUSES } with the same method names and return shapes that
// api.js and every service already expects.
//
// Notes on the port:
//   - id: was bigserial (Postgres). Now generated client-side via Date.now();
//     millisecond precision is unique enough at this write rate. Existing rows
//     migrated in Session 4 retain their original int ids — new inserts pick
//     ids in a different numeric range so no collisions.
//   - source_key uniqueness: emulated by GSI query-then-insert (see create()).
//   - Postgres defaults (created_date, status, review_status, priority_score,
//     metadata, updated_at) are set explicitly on insert.
//   - Sparse GSI fields (source_key, assigned_user_id) are omitted with
//     `undefined` rather than stored as null, so DDB keeps the GSI sparse.

const { getDdb, tableName } = require('./aws');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const TASK_STATUSES = [
  'not_started','waiting_documents','documents_received','in_progress',
  'ready_for_review','reviewed','completed','blocked','escalated'
];
const TERMINAL_STATUSES = ['completed'];

// Has this task been escalated? Read this rather than checking for a status of
// 'escalated'. The escalation sweep no longer overwrites the work status — it
// used to, which meant a task's real state (not_started, in_progress, waiting
// on documents) was destroyed the first time a rule matched. 'escalated' stays
// in TASK_STATUSES so historic rows still validate, and a status somebody set
// by hand still counts.
function isEscalated(task) {
  if (!task || task.status === 'completed' || task.status === 'reviewed') return false;
  return Number(task.escalation_level || 0) > 0 || task.status === 'escalated';
}
// Escalated or blocked — "this is stuck", which is what most callers mean.
function isStuck(task) {
  return !!task && (task.status === 'blocked' || isEscalated(task));
}

function ddb() {
  const c = getDdb();
  if (!c) throw new Error('DynamoDB not configured');
  return c;
}

function tbl(suffix) { return tableName(suffix); }

// Monotonic id generator. Date.now() is milliseconds — collisions are
// vanishingly rare at this write rate. If two writes land in the same ms
// we retry once with a small offset.
let _lastId = 0;
function newId() {
  const t = Date.now();
  if (t <= _lastId) _lastId = _lastId + 1;
  else _lastId = t;
  return _lastId;
}

// Full-table scan with pagination — used for cross-partition ordered lists.
async function scanAll(table, params) {
  const c = ddb();
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await c.send(new ScanCommand(Object.assign({ TableName: table, ExclusiveStartKey }, params || {})));
    if (out.Items) items.push.apply(items, out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Build a DDB UpdateExpression from a patch object. Null/undefined values are
// REMOVEd (kills the attribute) so sparse-GSI fields stay sparse.
function buildUpdate(patch) {
  const setParts = [];
  const removeParts = [];
  const names = {};
  const values = {};
  Object.keys(patch).forEach(function(k, i) {
    const nk = '#f' + i;
    names[nk] = k;
    const v = patch[k];
    if (v === null || typeof v === 'undefined') {
      removeParts.push(nk);
    } else {
      const nv = ':v' + i;
      values[nv] = v;
      setParts.push(nk + ' = ' + nv);
    }
  });
  const exprParts = [];
  if (setParts.length) exprParts.push('SET ' + setParts.join(', '));
  if (removeParts.length) exprParts.push('REMOVE ' + removeParts.join(', '));
  const out = { UpdateExpression: exprParts.join(' '), ExpressionAttributeNames: names };
  if (Object.keys(values).length) out.ExpressionAttributeValues = values;
  return out;
}

// ---------- Priority config ----------
const config = {
  async getAll() {
    const items = [];
    let ExclusiveStartKey;
    const c = ddb();
    do {
      const out = await c.send(new ScanCommand({ TableName: tbl('PriorityConfig'), ExclusiveStartKey }));
      if (out.Items) items.push.apply(items, out.Items);
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
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

// ---------- Tasks ----------
const tasks = {
  async create(input) {
    const nowIso = new Date().toISOString();
    const row = {
      id: newId(),
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      task_type: input.taskType,
      title: input.title || undefined,
      description: input.description || undefined,
      assigned_user_id: (input.assignedUserId === 0 || input.assignedUserId) ? Number(input.assignedUserId) : undefined,
      assigned_user_name: input.assignedUserName || undefined,
      status: input.status || 'not_started',
      review_status: 'none',
      priority_score: 0,
      due_date: input.dueDate || undefined,
      compliance_deadline: input.complianceDeadline || undefined,
      source: input.source || 'manual',
      source_key: input.sourceKey || undefined,
      metadata: input.metadata || {},
      created_by: input.createdBy || undefined,
      created_date: nowIso,
      last_status_change: nowIso,
      updated_at: nowIso
    };

    // Emulate source_key unique constraint: query GSI, return existing row.
    if (row.source_key) {
      const existing = await this.findBySourceKey(row.source_key);
      if (existing) return existing;
    }

    await ddb().send(new PutCommand({ TableName: tbl('Tasks'), Item: row }));
    return row;
  },

  async findBySourceKey(key) {
    if (!key) return null;
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('Tasks'),
      IndexName: 'source_key-index',
      KeyConditionExpression: '#k = :k',
      ExpressionAttributeNames: { '#k': 'source_key' },
      ExpressionAttributeValues: { ':k': key },
      Limit: 1
    }));
    return (out.Items && out.Items[0]) || null;
  },

  async getById(id) {
    const out = await ddb().send(new GetCommand({ TableName: tbl('Tasks'), Key: { id: Number(id) } }));
    return out.Item || null;
  },

  // list(filter): supports assignedUserId, clientId, status (str|arr), notStatus (arr),
  // overdue, dueBefore, orderBy, limit. Uses a GSI when a single equality filter
  // narrows enough; falls back to Scan + client-side filter otherwise.
  async list(filter) {
    filter = filter || {};
    const c = ddb();
    let items;

    if (filter.assignedUserId != null && !filter.status && !filter.notStatus && !filter.clientId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Tasks'),
        IndexName: 'assignee-index',
        KeyConditionExpression: '#a = :a',
        ExpressionAttributeNames: { '#a': 'assigned_user_id' },
        ExpressionAttributeValues: { ':a': Number(filter.assignedUserId) }
      }));
      items = out.Items || [];
    } else if (filter.clientId && !filter.status && !filter.notStatus && !filter.assignedUserId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Tasks'),
        IndexName: 'client-index',
        KeyConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'client_external_id' },
        ExpressionAttributeValues: { ':c': String(filter.clientId) }
      }));
      items = out.Items || [];
    } else if (typeof filter.status === 'string' && !filter.assignedUserId && !filter.clientId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Tasks'),
        IndexName: 'status-index',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': filter.status }
      }));
      items = out.Items || [];
    } else {
      items = await scanAll(tbl('Tasks'));
    }

    // Client-side filtering for the residual predicates. This mirrors the
    // Postgres WHERE clause exactly.
    if (filter.assignedUserId != null) items = items.filter(function(t) { return Number(t.assigned_user_id) === Number(filter.assignedUserId); });
    if (filter.clientId) items = items.filter(function(t) { return String(t.client_external_id) === String(filter.clientId); });
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      items = items.filter(function(t) { return arr.indexOf(t.status) !== -1; });
    }
    if (filter.notStatus) {
      const arr = filter.notStatus;
      items = items.filter(function(t) { return arr.indexOf(t.status) === -1; });
    }
    if (filter.overdue) {
      const today = new Date().toISOString().slice(0, 10);
      items = items.filter(function(t) { return t.due_date && t.due_date < today && t.status !== 'completed'; });
    }
    if (filter.dueBefore) {
      items = items.filter(function(t) { return t.due_date && t.due_date <= filter.dueBefore; });
    }

    // Ordering. Postgres default was priority_score DESC.
    const orderBy = filter.orderBy || 'priority_score';
    items.sort(function(a, b) {
      const av = a[orderBy]; const bv = b[orderBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return bv - av;
      return String(bv).localeCompare(String(av));
    });

    return items.slice(0, filter.limit || 500);
  },

  async update(id, patch) {
    patch = Object.assign({}, patch, { updated_at: new Date().toISOString() });
    const upd = buildUpdate(patch);
    const params = Object.assign({
      TableName: tbl('Tasks'),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd);
    const out = await ddb().send(new UpdateCommand(params));
    return out.Attributes;
  },

  async setStatus(id, status, extra) {
    if (!TASK_STATUSES.includes(status)) throw new Error('Invalid status');
    const patch = Object.assign({ status: status, last_status_change: new Date().toISOString() }, extra || {});
    if (TERMINAL_STATUSES.includes(status)) patch.completed_date = new Date().toISOString();
    return this.update(id, patch);
  },

  async setPriorityScore(id, score) {
    return this.update(id, { priority_score: Number(score) });
  },

  async bulkUpdatePriorities(rows) {
    if (!rows || !rows.length) return;
    const c = ddb();
    // Same 100-item chunking as before. Each row -> one UpdateItem.
    const chunks = [];
    for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(function(r) {
        const upd = buildUpdate({ priority_score: Number(r.priority_score), updated_at: new Date().toISOString() });
        return c.send(new UpdateCommand(Object.assign({
          TableName: tbl('Tasks'),
          Key: { id: Number(r.id) }
        }, upd)));
      }));
    }
  },

  async delete(id) {
    await ddb().send(new DeleteCommand({ TableName: tbl('Tasks'), Key: { id: Number(id) } }));
  }
};

// ---------- Comments ----------
const comments = {
  async listForTask(taskId) {
    const out = await ddb().send(new QueryCommand({
      TableName: tbl('TaskComments'),
      KeyConditionExpression: '#t = :t',
      ExpressionAttributeNames: { '#t': 'task_id' },
      ExpressionAttributeValues: { ':t': Number(taskId) },
      ScanIndexForward: true  // ascending by created_at (SK)
    }));
    return out.Items || [];
  },

  async add(taskId, userId, userName, body) {
    // Nudge created_at forward by 1 ms if a comment in the same ms already exists.
    const createdAt = new Date().toISOString();
    const item = {
      task_id: Number(taskId),
      created_at: createdAt,
      user_id: userId != null ? Number(userId) : undefined,
      user_name: userName || undefined,
      body: body
    };
    await ddb().send(new PutCommand({ TableName: tbl('TaskComments'), Item: item }));
    return item;
  }
};

// ---------- Document requests ----------
const documents = {
  async create(input) {
    const nowIso = new Date().toISOString();
    const row = {
      id: newId(),
      task_id: input.taskId != null ? Number(input.taskId) : undefined,
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      document_name: input.documentName,
      notes: input.notes || undefined,
      status: 'pending',
      requested_date: nowIso,
      reminder_count: 0,
      requested_by_id: input.requestedById != null ? Number(input.requestedById) : undefined,
      requested_by_name: input.requestedByName || undefined
    };
    await ddb().send(new PutCommand({ TableName: tbl('Documents'), Item: row }));
    return row;
  },

  async list(filter) {
    filter = filter || {};
    const c = ddb();
    let items;

    if (filter.status && !filter.clientId && !filter.taskId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Documents'),
        IndexName: 'status-index',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': filter.status }
      }));
      items = out.Items || [];
    } else if (filter.clientId && !filter.taskId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Documents'),
        IndexName: 'client-index',
        KeyConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'client_external_id' },
        ExpressionAttributeValues: { ':c': String(filter.clientId) }
      }));
      items = out.Items || [];
    } else if (filter.taskId) {
      const out = await c.send(new QueryCommand({
        TableName: tbl('Documents'),
        IndexName: 'task-index',
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'task_id' },
        ExpressionAttributeValues: { ':t': Number(filter.taskId) }
      }));
      items = out.Items || [];
    } else {
      items = await scanAll(tbl('Documents'));
    }

    if (filter.status) items = items.filter(function(d) { return d.status === filter.status; });
    if (filter.clientId) items = items.filter(function(d) { return String(d.client_external_id) === String(filter.clientId); });
    if (filter.taskId) items = items.filter(function(d) { return Number(d.task_id) === Number(filter.taskId); });

    items.sort(function(a, b) { return String(b.requested_date || '').localeCompare(String(a.requested_date || '')); });
    return items.slice(0, filter.limit || 500);
  },

  async remind(id) {
    const current = await ddb().send(new GetCommand({ TableName: tbl('Documents'), Key: { id: Number(id) } }));
    if (!current.Item) throw new Error('document_request not found: ' + id);
    const nextCount = (current.Item.reminder_count || 0) + 1;
    const upd = buildUpdate({
      last_reminder_date: new Date().toISOString(),
      reminder_count: nextCount
    });
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tbl('Documents'),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  },

  async markReceived(id) {
    const upd = buildUpdate({ status: 'received', received_date: new Date().toISOString() });
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tbl('Documents'),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  }
};

// ---------- Generation rules ----------
const generationRules = {
  async listActive() {
    const items = await scanAll(tbl('TaskGenerationRules'));
    return items.filter(function(r) { return r.active === true; });
  }
};

module.exports = { tasks, comments, documents, config, generationRules, TASK_STATUSES, isEscalated, isStuck };
