// Client Health Score (0-100). Pure function operating on already-loaded data.
// Weights live in compliance_health_weights — caller fetches once and passes in.

const compliance = require('./compliance');
const { obligations } = require('./obligations');
const { HealthWeightsRepo } = require('./repositories');

const DAY = 24 * 60 * 60 * 1000;
function daysAgo(d) { return Math.floor((Date.now() - new Date(d).getTime()) / DAY); }

async function getWeights() {
  try {
    const map = await HealthWeightsRepo.getAll();
    return Object.assign(defaults(), map || {});
  } catch (e) {
    console.warn('[healthScore] getWeights:', e.message);
    return defaults();
  }
}
function defaults() {
  return {
    base_score: 100, overdue_per_task: 15, overdue_cap: 40,
    blocked_per_task: 10, blocked_cap: 25,
    doc_pending_over_7d: 5, review_pending_over_3d: 5,
    unstarted_deadline_within_7d: 10, recent_activity_bonus: 5,
    band_healthy: 80, band_watch: 60, band_at_risk: 40
  };
}

function bandFor(score, w) {
  if (score >= w.band_healthy) return 'healthy';
  if (score >= w.band_watch) return 'watch';
  if (score >= w.band_at_risk) return 'at_risk';
  return 'critical';
}

// Computes the score using already-supplied data (so callers can batch fetches).
function computeFromData(clientId, tasks, docs, obls, recentActivity, weights) {
  const w = weights || defaults();
  const today = Date.now();
  let score = w.base_score;
  const factors = [];

  const openTasks = tasks.filter(t => t.status !== 'completed');
  const overdue = openTasks.filter(t => t.due_date && new Date(t.due_date).getTime() < today);
  const blocked = openTasks.filter(t => t.status === 'blocked' || t.status === 'escalated');
  const reviewStuck = openTasks.filter(t => t.status === 'ready_for_review' && daysAgo(t.last_status_change) > 3);
  const docsStale = docs.filter(d => d.status === 'pending' && daysAgo(d.requested_date) > 7);
  const dueSoonUnstarted = obls.filter(o => {
    if (!o.filing_deadline) return false;
    const days = Math.floor((new Date(o.filing_deadline).getTime() - today) / DAY);
    if (days < 0 || days > 7) return false;
    // unstarted = no linked open task in_progress/ready_for_review/reviewed
    const linked = tasks.find(t => t.obligation_id === o.id);
    if (!linked) return true;
    return ['not_started', 'waiting_documents'].includes(linked.status);
  });

  const overdueLoss = Math.min(w.overdue_cap, overdue.length * w.overdue_per_task);
  const blockedLoss = Math.min(w.blocked_cap, blocked.length * w.blocked_per_task);
  const reviewLoss = reviewStuck.length * w.review_pending_over_3d;
  const docLoss = docsStale.length * w.doc_pending_over_7d;
  const unstartedLoss = dueSoonUnstarted.length * w.unstarted_deadline_within_7d;

  score -= overdueLoss; if (overdueLoss) factors.push({ key:'overdue', count: overdue.length, impact: -overdueLoss });
  score -= blockedLoss; if (blockedLoss) factors.push({ key:'blocked', count: blocked.length, impact: -blockedLoss });
  score -= reviewLoss;  if (reviewLoss)  factors.push({ key:'review_stuck', count: reviewStuck.length, impact: -reviewLoss });
  score -= docLoss;     if (docLoss)     factors.push({ key:'missing_docs', count: docsStale.length, impact: -docLoss });
  score -= unstartedLoss; if (unstartedLoss) factors.push({ key:'unstarted_deadline', count: dueSoonUnstarted.length, impact: -unstartedLoss });

  if (recentActivity) { score += w.recent_activity_bonus; factors.push({ key:'recent_activity', count: 1, impact: w.recent_activity_bonus }); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { clientId, score, band: bandFor(score, w), factors };
}

async function computeForClient(client) {
  const w = await getWeights();
  const [tasks, docs, obls] = await Promise.all([
    compliance.tasks.list({ clientId: client.id, limit: 500 }),
    compliance.documents.list({ clientId: client.id, limit: 500 }),
    obligations.list({ clientId: client.id, limit: 500 })
  ]);
  const recentActivity = tasks.some(t => t.last_activity_at && daysAgo(t.last_activity_at) <= 3);
  return computeFromData(client.id, tasks, docs, obls, recentActivity, w);
}

async function computeForAll(clients) {
  const w = await getWeights();
  // Batch-fetch everything once
  const [allTasks, allDocs, allObls] = await Promise.all([
    compliance.tasks.list({ limit: 5000 }),
    compliance.documents.list({ limit: 5000, status: 'pending' }),
    obligations.list({ limit: 5000 })
  ]);
  const byClient = id => x => String(x.client_external_id) === String(id);
  return (clients || []).map(c => {
    const tasks = allTasks.filter(byClient(c.id));
    const docs = allDocs.filter(byClient(c.id));
    const obls = allObls.filter(byClient(c.id));
    const recent = tasks.some(t => t.last_activity_at && daysAgo(t.last_activity_at) <= 3);
    return Object.assign({ clientName: c.name }, computeFromData(c.id, tasks, docs, obls, recent, w));
  }).sort((a,b) => a.score - b.score);
}

module.exports = { computeForClient, computeForAll, getWeights, bandFor };
