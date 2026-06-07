// Portfolio Insights — six top-10 lists for management.
const portfolioDashboard = require('./portfolioDashboardService');

async function generate() {
  const d = await portfolioDashboard.getDashboard();
  const rows = d.rows;

  const topRisk        = rows.slice().sort((a,b) => (b.overallRisk||0) - (a.overallRisk||0)).slice(0, 10);
  const topMaintenance = rows.slice().sort((a,b) => (b.effortScore||0) - (a.effortScore||0)).slice(0, 10);
  const mostOverdue    = rows.slice().filter(r => r.overdueTasks > 0).sort((a,b) => b.overdueTasks - a.overdueTasks).slice(0, 10);
  const mostDocs       = rows.slice().filter(r => r.documentsPending > 0).sort((a,b) => b.documentsPending - a.documentsPending).slice(0, 10);
  const partnerAttn    = rows.slice().filter(r => r.tier === 'A' && (r.riskBand === 'high' || r.riskBand === 'critical')).slice(0, 10);
  const leastResponsive= rows.slice().filter(r => r.responsivenessScore != null).sort((a,b) => (a.responsivenessScore||0) - (b.responsivenessScore||0)).slice(0, 10);

  return {
    topHighestRisk: topRisk,
    topHighestMaintenance: topMaintenance,
    mostOverdue,
    mostDocumentDelays: mostDocs,
    requirePartnerAttention: partnerAttn,
    leastResponsive
  };
}

module.exports = { generate };
