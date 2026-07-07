// EventBridge → Lambda handler: hourly SLA status recompute.
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const { initDatabase } = require('../database');
const slaMonitor = require('../slaMonitor');

let bootPromise = null;

exports.handler = async function() {
  if (!bootPromise) bootPromise = initDatabase();
  await bootPromise;
  try { return { ok: true, result: await slaMonitor.recomputeAll() }; }
  catch (e) { console.error('[slaCron]', e); return { ok: false, error: e.message }; }
};
