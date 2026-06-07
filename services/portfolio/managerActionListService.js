// Manager Action List — the daily portfolio review screen. Supersedes the
// Phase 6 Attention Required report in the Portfolio UI; the older report
// remains available for backward compatibility.
//
// Ranking blends five inputs and applies the tier multiplier:
//
//   score = (overall_risk × 0.7
//          + open_escalations × 8
//          + upcoming_deadlines × 4
//          + max(0, 100 - responsivenessScore) × 0.3
//          + stale_documents × 5)
//          × tier_multiplier
//          + (has_key_alert ? +25 : 0)

const portfolioDashboard = require('./portfolioDashboardService');
const keyAlertsSvc = require('./keyClientAlertsService');
const clientSettings = require('./clientSettingsService');

async function generate(limit) {
  const top = limit || 25;
  const [d, alerts, multipliers] = await Promise.all([
    portfolioDashboard.getDashboard(),
    keyAlertsSvc.generate(),
    clientSettings.tierMultipliers()
  ]);
  const alertsByClient = {};
  (alerts.alerts || []).forEach(a => { (alertsByClient[String(a.clientId)] = alertsByClient[String(a.clientId)] || []).push(a); });

  const rows = d.rows.map(r => {
    const cid = String(r.clientId);
    const mult = multipliers[r.tier] || 1.0;
    const respGap = r.responsivenessScore != null ? Math.max(0, 100 - r.responsivenessScore) : 30;
    const base = (r.overallRisk || 0) * 0.7
      + (r.openEscalations || 0) * 8
      + (r.upcomingDeadlines || 0) * 4
      + respGap * 0.3
      + (r.documentsPending || 0) * 5;
    const alertsForClient = alertsByClient[cid] || [];
    const score = Math.round(base * mult + (alertsForClient.length ? 25 : 0));

    const reasons = [];
    if (r.riskBand === 'critical' || r.riskBand === 'high') reasons.push(r.riskBand + ' risk');
    if (r.openEscalations) reasons.push(r.openEscalations + ' open escalation(s)');
    if (r.upcomingDeadlines) reasons.push(r.upcomingDeadlines + ' due ≤7d');
    if (r.documentsPending) reasons.push(r.documentsPending + ' doc(s) pending');
    if (respGap > 50) reasons.push('low responsiveness');
    if (r.tier === 'A') reasons.push('Tier A');
    alertsForClient.forEach(a => reasons.push(a.kind.replace(/_/g,' ')));

    return {
      clientId: r.clientId, clientName: r.clientName, owner: r.owner,
      tier: r.tier, partnerOwner: r.partnerOwner,
      riskBand: r.riskBand, overallRisk: r.overallRisk,
      openEscalations: r.openEscalations,
      upcomingDeadlines: r.upcomingDeadlines,
      documentsPending: r.documentsPending,
      responsivenessScore: r.responsivenessScore,
      effortScore: r.effortScore,
      score,
      hasKeyAlert: alertsForClient.length > 0,
      alerts: alertsForClient.map(a => ({ kind: a.kind, severity: a.severity, evidence: a.evidence })),
      reasons
    };
  })
    .filter(r => r.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, top);

  return {
    columns: ['clientName','tier','partnerOwner','riskBand','score','openEscalations','upcomingDeadlines','documentsPending','responsivenessScore','effortScore','hasKeyAlert','reasons'],
    rows
  };
}

module.exports = { generate };
