// ClientSettingsRepo — DynamoDB-backed (migrated from Supabase in Session 3).
// Table: UctClientSettings  PK: client_external_id

const { getDdb, tableName } = require('../aws');
const { GetCommand, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

function ddb() { const c = getDdb(); if (!c) throw new Error('DynamoDB not configured'); return c; }
function tbl() { return tableName('ClientSettings'); }

const ClientSettingsRepo = {
  async getForClient(clientId) {
    const out = await ddb().send(new GetCommand({
      TableName: tbl(),
      Key: { client_external_id: String(clientId) }
    }));
    return out.Item || null;
  },

  async getAll() {
    const c = ddb();
    const items = []; let ExclusiveStartKey;
    do {
      const out = await c.send(new ScanCommand({ TableName: tbl(), ExclusiveStartKey }));
      if (out.Items) items.push.apply(items, out.Items);
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  },

  async upsert(clientId, payload, actor) {
    const existing = await this.getForClient(clientId);
    const item = Object.assign(
      { client_external_id: String(clientId), tier: 'B' },
      existing || {},
      payload || {},
      { updated_at: new Date().toISOString() }
    );
    if (actor) { item.updated_by_id = actor.id; item.updated_by_name = actor.name; }
    Object.keys(item).forEach(function(k) { if (item[k] == null) delete item[k]; });
    await ddb().send(new PutCommand({ TableName: tbl(), Item: item }));
    return item;
  }
};

module.exports = { ClientSettingsRepo };
