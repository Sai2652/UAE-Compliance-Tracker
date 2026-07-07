// Users repo — DynamoDB-backed.
// Table: <prefix>Users
//   PK: id (Number)
//   GSI email-index:        PK email (String)
//   GSI invite_token-index: PK invite_token (String, sparse)
//
// database.js uses this for hydration on boot and write-through on mutations.
// Every method is defensive: if AWS is not configured, returns a neutral
// value and logs a warning, so the app can still boot for local/offline work.

const { getDdb, tableName } = require('../aws');

function tbl() { return tableName('Users'); }

const UsersDataRepo = {
  async listAll() {
    const c = getDdb(); if (!c) return [];
    try {
      const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
      const rows = [];
      let ExclusiveStartKey;
      do {
        const out = await c.send(new ScanCommand({ TableName: tbl(), ExclusiveStartKey }));
        if (out.Items) rows.push.apply(rows, out.Items);
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      rows.sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
      return rows;
    } catch (e) {
      console.warn('[usersRepo] listAll:', e.message);
      return [];
    }
  },

  async upsert(row) {
    const c = getDdb(); if (!c) return null;
    try {
      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      const item = {
        id: Number(row.id),
        email: row.email,
        password: row.password,
        name: row.name,
        role: row.role,
        active: row.active,
        invite_token: row.invite_token || undefined,   // sparse GSI: omit rather than null
        invite_expires: row.invite_expires || undefined,
        created_at: row.created_at,
        last_login: row.last_login || undefined
      };
      await c.send(new PutCommand({ TableName: tbl(), Item: item }));
      return item;
    } catch (e) {
      console.warn('[usersRepo] upsert:', e.message);
      return null;
    }
  },

  // Patch a subset of fields on an existing user. Null values are erased
  // (REMOVE) so the invite_token GSI stays sparse.
  async patch(id, fields) {
    const c = getDdb(); if (!c) return;
    try {
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      const setParts = [];
      const removeParts = [];
      const names = {};
      const values = {};
      Object.keys(fields).forEach(function(k, i) {
        const nk = '#f' + i;
        names[nk] = k;
        if (fields[k] === null || typeof fields[k] === 'undefined') {
          removeParts.push(nk);
        } else {
          const nv = ':v' + i;
          values[nv] = fields[k];
          setParts.push(nk + ' = ' + nv);
        }
      });
      const parts = [];
      if (setParts.length) parts.push('SET ' + setParts.join(', '));
      if (removeParts.length) parts.push('REMOVE ' + removeParts.join(', '));
      if (!parts.length) return;
      const params = {
        TableName: tbl(),
        Key: { id: Number(id) },
        UpdateExpression: parts.join(' '),
        ExpressionAttributeNames: names
      };
      if (Object.keys(values).length) params.ExpressionAttributeValues = values;
      await c.send(new UpdateCommand(params));
    } catch (e) {
      console.warn('[usersRepo] patch(' + id + '):', e.message);
    }
  },

  async remove(id) {
    const c = getDdb(); if (!c) return;
    try {
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      await c.send(new DeleteCommand({ TableName: tbl(), Key: { id: Number(id) } }));
    } catch (e) {
      console.warn('[usersRepo] remove(' + id + '):', e.message);
    }
  }
};

module.exports = { UsersDataRepo };
