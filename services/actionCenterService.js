// Manager Action Center — the "Requires Manager Attention" list. Surfaces
// only items where a manager decision is needed; not just counts.
const riskService = require('./riskService');
const capacity = require('./capacityService');

async function getActionCenter() {
  const [{ findings }, capDash] = await Promise.all([
    riskService.runAll(),
    capacity.getCapacityDashboard()
  ]);

  const overloaded = capDash.rows.filter(r => r.band === 'overloaded');

  const items = [];

  // 1. Filing-due-soon items.
  findings.filter(f => f.kind === 'deadline_approaching' && f.level === 'critical').forEach(f => items.push(actionItem('Filing due within 3 days', f, 'Approve reassignment or escalate.')));

  // 2. Client confirmation pending.
  findings.filter(f => f.kind === 'client_confirmation_pending').forEach(f => items.push(actionItem('Client confirmation pending', f, 'Follow up with client today.')));

  // 3. Stale critical docs.
  findings.filter(f => f.kind === 'missing_document' && f.level === 'high').forEach(f => items.push(actionItem('Critical document missing', f, 'Escalate the document request.')));

  // 4. High-risk findings on critical clients.
  findings.filter(f => f.level === 'critical').forEach(f => items.push(actionItem('Critical risk', f, f.recommendation || 'Take action.')));

  // 5. Overloaded staff.
  overloaded.forEach(o => items.push({
    title: 'Overloaded team member',
    detail: `${o.userName} workload ratio ${o.workloadRatio}`,
    recommendation: 'Rebalance — see Workload tab.',
    severity: 'high',
    link: { kind: 'user', id: o.userId, name: o.userName }
  }));

  // Cap and rank.
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a,b) => (order[a.severity]||9) - (order[b.severity]||9));
  return { items: items.slice(0, 25), overloadedUsers: overloaded.length };
}

function actionItem(title, finding, recommendation) {
  return {
    title,
    detail: `${finding.clientName || 'Unknown'} — ${finding.evidence}`,
    recommendation,
    severity: finding.level,
    clientId: finding.clientId,
    taskId: finding.taskId,
    link: finding.entity
  };
}

module.exports = { getActionCenter };
