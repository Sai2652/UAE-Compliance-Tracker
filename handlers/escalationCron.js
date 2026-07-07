// EventBridge → Lambda handler: escalation sweep + daily admin digest.
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const { initDatabase } = require('../database');
const escalationEngine = require('../escalationEngine');

let bootPromise = null;

exports.handler = async function(event) {
  if (!bootPromise) bootPromise = initDatabase();
  await bootPromise;
  const mode = (event && event.mode) || 'sweep';
  try {
    if (mode === 'digest') return { ok: true, result: await escalationEngine.dailyAdminDigests() };
    return { ok: true, result: await escalationEngine.runSweep() };
  } catch (e) { console.error('[escalationCron]', e); return { ok: false, error: e.message }; }
};
