// Client follow-up tracking — wraps communicationService and tags clients
// whose silence is contributing to compliance risk.
const repos = require('../repositories');
const communicationService = require('./communicationService');
const riskService = require('./riskService');

async function getFollowUpBoard() {
  const [comm, risk] = await Promise.all([
    communicationService.getCommunicationBoard(),
    riskService.runAll()
  ]);

  // Tag silent clients with their risk profile so managers can prioritize.
  const riskByClient = {};
  risk.findings.forEach(f => {
    if (f.clientId == null) return;
    const k = String(f.clientId);
    riskByClient[k] = riskByClient[k] || { critical:0, high:0, medium:0, low:0 };
    riskByClient[k][f.level]++;
  });

  const rows = (comm.clients || []).map(r => {
    const tally = riskByClient[String(r.clientId)] || { critical:0, high:0, medium:0, low:0 };
    return Object.assign({}, r, {
      riskFindings: tally,
      criticalRisk: tally.critical > 0 || tally.high > 0,
      causingFilingRisk: r.silent && (tally.critical + tally.high) > 0
    });
  }).sort((a,b) => {
    if (a.causingFilingRisk !== b.causingFilingRisk) return a.causingFilingRisk ? -1 : 1;
    if (a.silent !== b.silent) return a.silent ? -1 : 1;
    return (b.silenceDays || 0) - (a.silenceDays || 0);
  });

  return { clients: rows, silenceThresholdDays: comm.silenceThresholdDays };
}

module.exports = { getFollowUpBoard };
