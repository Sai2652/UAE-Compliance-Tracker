// WorkflowsRepo — DynamoDB-backed (migrated from Supabase in Session 3).
// Tables:
//   UctWorkflows      PK: id, GSI source_key-index, GSI client-index (SK updated_at)
//   UctWorkflowSteps  PK: workflow_id, SK: step_order

const { getDdb, tableName } = require('../aws');
const {
  GetCommand, PutCommand, UpdateCommand,
  QueryCommand, ScanCommand
} = require('@aws-sdk/lib-dynamodb');

function ddb() { const c = getDdb(); if (!c) throw new Error('DynamoDB not configured'); return c; }
function tblW()  { return tableName('Workflows'); }
function tblWS() { return tableName('WorkflowSteps'); }

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

const WorkflowsRepo = {
  async getBySourceKey(key) {
    if (!key) return null;
    const out = await ddb().send(new QueryCommand({
      TableName: tblW(),
      IndexName: 'source_key-index',
      KeyConditionExpression: '#k = :k',
      ExpressionAttributeNames: { '#k': 'source_key' },
      ExpressionAttributeValues: { ':k': key },
      Limit: 1
    }));
    return (out.Items && out.Items[0]) || null;
  },

  async getById(id) {
    const out = await ddb().send(new GetCommand({ TableName: tblW(), Key: { id: Number(id) } }));
    return out.Item || null;
  },

  async create(row) {
    if (row.source_key) {
      const existing = await this.getBySourceKey(row.source_key);
      if (existing) return existing;
    }
    const nowIso = new Date().toISOString();
    const item = Object.assign({
      id: newId(),
      status: 'active',
      created_at: nowIso,
      updated_at: nowIso
    }, row);
    // strip undefineds/nulls that would clash with sparse GSIs
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tblW(), Item: item }));
    return item;
  },

  async update(id, patch) {
    patch = Object.assign({}, patch, { updated_at: new Date().toISOString() });
    const upd = buildUpdate(patch);
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tblW(),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  },

  async list(filter) {
    filter = filter || {};
    let items;
    if (filter.clientId) {
      const out = await ddb().send(new QueryCommand({
        TableName: tblW(),
        IndexName: 'client-index',
        KeyConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'client_external_id' },
        ExpressionAttributeValues: { ':c': String(filter.clientId) },
        ScanIndexForward: false
      }));
      items = out.Items || [];
    } else {
      items = await scanAll(tblW());
    }
    if (filter.workflowType) {
      const arr = Array.isArray(filter.workflowType) ? filter.workflowType : [filter.workflowType];
      items = items.filter(function(w) { return arr.indexOf(w.workflow_type) !== -1; });
    }
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      items = items.filter(function(w) { return arr.indexOf(w.status) !== -1; });
    }
    items.sort(function(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    return items.slice(0, filter.limit || 1000);
  }
};

const WorkflowStepsRepo = {
  async listForWorkflow(workflowId) {
    const out = await ddb().send(new QueryCommand({
      TableName: tblWS(),
      KeyConditionExpression: '#w = :w',
      ExpressionAttributeNames: { '#w': 'workflow_id' },
      ExpressionAttributeValues: { ':w': Number(workflowId) },
      ScanIndexForward: true  // step_order ascending
    }));
    return out.Items || [];
  },

  // Batched: N parallel Queries. Same result shape as before.
  async listForWorkflows(workflowIds) {
    if (!workflowIds || !workflowIds.length) return {};
    const c = ddb();
    const results = await Promise.all(workflowIds.map(function(id) {
      return c.send(new QueryCommand({
        TableName: tblWS(),
        KeyConditionExpression: '#w = :w',
        ExpressionAttributeNames: { '#w': 'workflow_id' },
        ExpressionAttributeValues: { ':w': Number(id) },
        ScanIndexForward: true
      })).then(function(out) { return { id: Number(id), items: out.Items || [] }; });
    }));
    const map = {};
    results.forEach(function(r) { map[r.id] = r.items; });
    return map;
  },

  async bulkInsert(rows) {
    if (!rows || !rows.length) return [];
    const c = ddb();
    // No BatchWriteItem here — a step-key clash mid-batch is silent; individual
    // PutItems make failures explicit. Volumes are tiny (~10 rows per workflow).
    const written = [];
    for (const row of rows) {
      const item = Object.assign({}, row);
      item.workflow_id = Number(item.workflow_id);
      item.step_order = Number(item.step_order);
      if (item.status == null) item.status = 'locked';
      Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
      await c.send(new PutCommand({ TableName: tblWS(), Item: item }));
      written.push(item);
    }
    return written;
  },

  // Step id is (workflow_id, step_order). Repositories/index.js callers used
  // to pass the bigserial id; port callers pass an object { workflow_id, step_order }
  // OR the numeric id (kept for compat by internal lookup via scan).
  async update(idOrKey, patch) {
    const c = ddb();
    let key;
    if (idOrKey && typeof idOrKey === 'object' && idOrKey.workflow_id != null) {
      key = { workflow_id: Number(idOrKey.workflow_id), step_order: Number(idOrKey.step_order) };
    } else {
      const found = await this.getById(idOrKey);
      if (!found) throw new Error('workflow step not found: ' + idOrKey);
      key = { workflow_id: Number(found.workflow_id), step_order: Number(found.step_order) };
    }
    const upd = buildUpdate(patch);
    const out = await c.send(new UpdateCommand(Object.assign({
      TableName: tblWS(),
      Key: key,
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  },

  async getById(id) {
    // Legacy int-id lookup — scan for it.
    const items = await scanAll(tblWS());
    return items.find(function(s) { return Number(s.id) === Number(id); }) || null;
  }
};

module.exports = { WorkflowsRepo, WorkflowStepsRepo };
