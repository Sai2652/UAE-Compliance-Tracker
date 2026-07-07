// Local-dev entry point. On AWS Lambda, lambda.js is the handler instead;
// server.js is never executed there.
require('dotenv').config();
var { initDatabase } = require('./database');
var aws = require('./aws');
var taskEngine = require('./taskEngine');
var obligationEngine = require('./obligationEngine');
var escalationEngine = require('./escalationEngine');
var slaMonitor = require('./slaMonitor');
var { buildApp } = require('./app');

var PORT = process.env.PORT || 3000;
var app = buildApp();

initDatabase().then(function() {
  app.listen(PORT, '0.0.0.0', function() {
    console.log('');
    console.log('  UAE Compliance Tracker — AWS Edition');
    console.log('  Running at: http://localhost:' + PORT);
    console.log('  Admin: ' + (process.env.ADMIN_EMAIL || 'admin@tracker.com'));
    console.log('');
    // On Lambda, IS_LAMBDA=true — schedulers move to EventBridge; skip here.
    if (process.env.IS_LAMBDA === 'true') {
      console.log('[compliance] Running under Lambda — in-process schedulers disabled (using EventBridge)');
      return;
    }
    aws.probe().then(function(r) {
      if (!r.ok) {
        console.warn('[compliance] AWS probe failed:', r.error, '— engines disabled. Run npm run bootstrap-aws and set env vars.');
        return;
      }
      console.log('[compliance] AWS connected — engines starting');
      taskEngine.startScheduler();
      obligationEngine.startScheduler();
      escalationEngine.startScheduler();
      setTimeout(function(){ slaMonitor.recomputeAll().catch(function(e){ console.error('[sla] init:', e.message); }); }, 15000);
      setInterval(function(){ slaMonitor.recomputeAll().catch(function(e){ console.error('[sla]:', e.message); }); }, 60 * 60 * 1000);
    }).catch(function(e){ console.warn('[compliance] probe error:', e.message); });
  });
}).catch(function(e) {
  console.error('[boot] initDatabase failed:', e);
  process.exit(1);
});
