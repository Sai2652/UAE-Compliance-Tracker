// EventBridge → Lambda handler: task generation sweep + priority rescore.
// Cadence: hourly rescore + daily generation sweep (schedule in the CDK/SAM template).
require('dotenv').config();
process.env.IS_LAMBDA = 'true';

const { initDatabase } = require('../database');
const taskEngine = require('../taskEngine');

let bootPromise = null;

exports.handler = async function(event) {
  if (!bootPromise) bootPromise = initDatabase();
  await bootPromise;
  const mode = (event && event.mode) || 'both';
  const out = {};
  try {
    if (mode === 'generate' || mode === 'both') out.generate = await taskEngine.runGenerationSweep();
    if (mode === 'rescore' || mode === 'both')  out.rescore  = await taskEngine.recomputeAllPriorities();
  } catch (e) {
    console.error('[taskCron]', e);
    return { ok: false, error: e.message };
  }
  return { ok: true, mode, ...out };
};
