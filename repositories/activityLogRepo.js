// Activity log repo — DynamoDB-backed, append-only, most-recent-first.
// Table: <prefix>ActivityLog
//   PK: partition (String, always 'GLOBAL' — single-partition is fine at
//        this volume; <10 users × <100 events/day is far below the
//        1000 WCU/partition throttle)
//   SK: created_at (String, ISO-8601 — lexicographic order == chronological)
//
// database.js keeps the last 200 events in memory for sync reads; this
// repo is the durable side (boot hydration + write-through append).

const { getDdb, tableName } = require('../aws');

const PARTITION = 'GLOBAL';
function tbl() { return tableName('ActivityLog'); }

const ActivityLogRepo = {
  async listRecent(limit) {
    const c = getDdb(); if (!c) return [];
    try {
      const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
      const n = Math.min(Math.max(parseInt(limit || 200, 10) || 200, 1), 1000);
      const out = await c.send(new QueryCommand({
        TableName: tbl(),
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'partition' },
        ExpressionAttributeValues: { ':p': PARTITION },
        ScanIndexForward: false, // newest first
        Limit: n
      }));
      return out.Items || [];
    } catch (e) {
      console.warn('[activityLogRepo] listRecent:', e.message);
      return [];
    }
  },

  async append(row) {
    const c = getDdb(); if (!c) return;
    try {
      const { PutCommand } = require('@aws-sdk/lib-dynamodb');
      const createdAt = row.created_at || new Date().toISOString();
      const item = {
        partition: PARTITION,
        created_at: createdAt,
        // Include a client-side id for parity with the old int id; the
        // (partition, created_at) pair is the actual uniqueness constraint.
        client_id: row.id || null,
        user_id: row.user_id || null,
        user_name: row.user_name || null,
        action: row.action,
        details: row.details || null
      };
      await c.send(new PutCommand({ TableName: tbl(), Item: item }));
    } catch (e) {
      console.warn('[activityLogRepo] append:', e.message);
    }
  }
};

module.exports = { ActivityLogRepo };
