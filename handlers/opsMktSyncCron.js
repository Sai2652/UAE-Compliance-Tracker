// EventBridge → Lambda handler: pull newly signed Ops-Mkt clients.
//
// Runs once a night. Adds clients that have appeared in Ops-Mkt under a First
// POC this tracker follows; never edits or removes anything. If no POC has
// been selected yet it does nothing at all.
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const { initDatabase } = require('../database');
const opsMktEngine = require('../services/opsMktSyncEngine');

let bootPromise = null;

exports.handler = async function(event) {
  if (!bootPromise) bootPromise = initDatabase();
  await bootPromise;
  try {
    const result = await opsMktEngine.runAutoSync({ actor: 'Ops-Mkt auto-sync' });
    if (result.added) console.log('[opsMktSyncCron] added ' + result.added + ' client(s):', (result.newNames || []).join(', '));
    return { ok: true, result: result };
  } catch (e) {
    console.error('[opsMktSyncCron]', e);
    return { ok: false, error: e.message };
  }
};
