// Bottleneck Advisor — wraps bottleneckService output with a concrete
// reassignment / action recommendation per bucket. Pulls capacity data to
// suggest WHO should pick up the slack.

const bottleneckService = require('../bottleneckService');
const capacityService = require('../capacityService');
const explain = require('./explanationEngine');

async function generate() {
  const [bn, cap] = await Promise.all([
    bottleneckService.getBottlenecks(),
    capacityService.getCapacityDashboard()
  ]);

  // Pick up to 3 candidate users with the most spare capacity (not overloaded).
  const idle = (cap.rows || [])
    .filter(r => r.userId && r.band !== 'overloaded')
    .sort((a, b) => (a.workloadRatio || 0) - (b.workloadRatio || 0))
    .slice(0, 3);
  const idleNames = idle.map(u => u.userName).join(', ') || 'an available admin';

  const out = (bn.bottlenecks || []).map(b => {
    if (!b.isBottleneck) return null;
    const top = (b.topClients || []).slice(0, 3).map(c => `${c.name} (${c.count})`).join(', ');
    const headline = `${b.count} item(s) stuck in ${b.label}; oldest ${b.oldestDays}d.${top ? ' Top contributors: ' + top + '.' : ''}`;
    const recommendation = recommendationFor(b.key, b, idleNames, idle[0]);
    return { kind: b.key, label: b.label, count: b.count, oldestDays: b.oldestDays, topClients: b.topClients, headline, recommendation };
  }).filter(Boolean);

  return { bottlenecks: out, suggestedOwner: bn.suggestedOwner, candidates: idle.map(u => ({ userId: u.userId, userName: u.userName, ratio: u.workloadRatio })) };
}

function recommendationFor(key, bucket, idleNames, primaryIdle) {
  const primary = primaryIdle ? primaryIdle.userName : 'an available admin';
  switch (key) {
    case 'review':       return `Assign ${primary} to review ${bucket.count} pending item(s). Idle: ${idleNames}.`;
    case 'accounting':   return `Push ${bucket.count} accounting task(s) — partner involvement may be needed for the oldest (${bucket.oldestDays}d).`;
    case 'registration': return `Escalate VAT/CT registration backlog (${bucket.count}); these block downstream filings.`;
    case 'client_approval': return `Call top contributing clients today to unblock ${bucket.count} item(s) stuck on approval.`;
    case 'documents':    return `Send escalation reminders for ${bucket.count} stale document request(s); the oldest is ${bucket.oldestDays}d.`;
    default:             return `Address ${bucket.count} stuck item(s) in ${bucket.label}.`;
  }
}

module.exports = { generate };
