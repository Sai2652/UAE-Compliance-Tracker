// EventBridge → Lambda handler: obligation sync sweep.
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const { initDatabase } = require('../database');
const obligationEngine = require('../obligationEngine');

let bootPromise = null;

exports.handler = async function(event) {
  if (!bootPromise) bootPromise = initDatabase();
  await bootPromise;
  try { return { ok: true, result: await obligationEngine.runFullSweep() }; }
  catch (e) { console.error('[obligationCron]', e); return { ok: false, error: e.message }; }
};
