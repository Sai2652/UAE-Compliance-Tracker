// Obligations data layer — DynamoDB-backed (migrated from Supabase in Session 2).
// Public shape unchanged: exports { obligations } with same method signatures.
//
// Table: UctObligations
//   PK: id (Number, generated client-side)
//   GSI source_key-index: PK source_key (sparse, upsert dedup)
//   GSI client-index:     PK client_external_id, SK filing_deadline

const { getDdb, tableName } = require('./aws');
const {
  GetCommand, PutCommand, UpdateCommand,
  QueryCommand, ScanCommand, DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

function ddb() {
  const c = getDdb();
  if (!c) throw new Error('DynamoDB not configured');
  return c;
}

function tbl() { return tableName('Obligations'); }

let _lastId = 0;
function newId() {
  const t = Date.now();
  if (t <= _lastId) _lastId = _lastId + 1;
  else _lastId = t;
  return _lastId;
}

async function scanAll(params) {
  const c = ddb();
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await c.send(new ScanCommand(Object.assign({ TableName: tbl(), ExclusiveStartKey }, params || {})));
    if (out.Items) items.push.apply(items, out.Items);
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

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
  const parts = [];
  if (setParts.length) parts.push('SET ' + setParts.join(', '));
  if (removeParts.length) parts.push('REMOVE ' + removeParts.join(', '));
  const out = { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names };
  if (Object.keys(values).length) out.ExpressionAttributeValues = values;
  return out;
}

async function findBySourceKey(key) {
  if (!key) return null;
  const out = await ddb().send(new QueryCommand({
    TableName: tbl(),
    IndexName: 'source_key-index',
    KeyConditionExpression: '#k = :k',
    ExpressionAttributeNames: { '#k': 'source_key' },
    ExpressionAttributeValues: { ':k': key },
    Limit: 1
  }));
  return (out.Items && out.Items[0]) || null;
}

const obligations = {
  async upsert(input) {
    const nowIso = new Date().toISOString();
    const base = {
      client_external_id: String(input.clientId),
      client_name: input.clientName,
      obligation_type: input.obligationType,
      period_label: input.periodLabel,
      period_start: input.periodStart || undefined,
      period_end: input.periodEnd || undefined,
      filing_deadline: input.filingDeadline,
      payment_deadline: input.paymentDeadline || undefined,
      source_key: input.sourceKey,
      metadata: input.metadata || {},
      updated_at: nowIso
    };
    if (input.status) base.status = input.status;

    const existing = await findBySourceKey(input.sourceKey);
    if (existing) {
      const patch = Object.assign({}, base);
      const upd = buildUpdate(patch);
      const out = await ddb().send(new UpdateCommand(Object.assign({
        TableName: tbl(),
        Key: { id: Number(existing.id) },
        ReturnValues: 'ALL_NEW'
      }, upd)));
      return out.Attributes;
    }

    const row = Object.assign({ id: newId(), status: input.status || 'pending', created_at: nowIso }, base);
    await ddb().send(new PutCommand({ TableName: tbl(), Item: row }));
    return row;
  },

  async list(filter) {
    filter = filter || {};
    const c = ddb();
    let items;

    if (filter.clientId) {
      const kexp = ['#c = :c'];
      const names = { '#c': 'client_external_id' };
      const values = { ':c': String(filter.clientId) };
      if (filter.from && filter.to) {
        kexp.push('#d BETWEEN :from AND :to');
        names['#d'] = 'filing_deadline';
        values[':from'] = filter.from;
        values[':to'] = filter.to;
      } else if (filter.from) {
        kexp.push('#d >= :from');
        names['#d'] = 'filing_deadline';
        values[':from'] = filter.from;
      } else if (filter.to) {
        kexp.push('#d <= :to');
        names['#d'] = 'filing_deadline';
        values[':to'] = filter.to;
      }
      const out = await c.send(new QueryCommand({
        TableName: tbl(),
        IndexName: 'client-index',
        KeyConditionExpression: kexp.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: true
      }));
      items = out.Items || [];
    } else {
      items = await scanAll();
    }

    if (filter.type) {
      const arr = Array.isArray(filter.type) ? filter.type : [filter.type];
      items = items.filter(function(o) { return arr.indexOf(o.obligation_type) !== -1; });
    }
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      items = items.filter(function(o) { return arr.indexOf(o.status) !== -1; });
    }
    if (filter.from) items = items.filter(function(o) { return o.filing_deadline && o.filing_deadline >= filter.from; });
    if (filter.to)   items = items.filter(function(o) { return o.filing_deadline && o.filing_deadline <= filter.to; });

    items.sort(function(a, b) { return String(a.filing_deadline || '').localeCompare(String(b.filing_deadline || '')); });
    return items.slice(0, filter.limit || 1000);
  },

  async getById(id) {
    const out = await ddb().send(new GetCommand({ TableName: tbl(), Key: { id: Number(id) } }));
    return out.Item || null;
  },

  async setStatus(id, status, extra) {
    const patch = Object.assign({ status: status, updated_at: new Date().toISOString() }, extra || {});
    if (status === 'filed') patch.filed_at = new Date().toISOString();
    const upd = buildUpdate(patch);
    const out = await ddb().send(new UpdateCommand(Object.assign({
      TableName: tbl(),
      Key: { id: Number(id) },
      ReturnValues: 'ALL_NEW'
    }, upd)));
    return out.Attributes;
  },

  async deleteForClient(clientId, fromDeadline) {
    // Query the client-index partition, then filter and DeleteItem each match.
    const c = ddb();
    const params = {
      TableName: tbl(),
      IndexName: 'client-index',
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': 'client_external_id' },
      ExpressionAttributeValues: { ':c': String(clientId) }
    };
    if (fromDeadline) {
      params.KeyConditionExpression += ' AND #d >= :d';
      params.ExpressionAttributeNames['#d'] = 'filing_deadline';
      params.ExpressionAttributeValues[':d'] = fromDeadline;
    }
    const out = await c.send(new QueryCommand(params));
    const victims = (out.Items || []).filter(function(o) { return o.status !== 'filed'; });
    for (const v of victims) {
      await c.send(new DeleteCommand({ TableName: tbl(), Key: { id: Number(v.id) } }));
    }
  }
};

module.exports = { obligations };
