// Service Quality Score (0-100, higher = firm is serving this client well).
// Inputs are firm-side performance signals (filing timeliness, SLA breaches,
// review aging, firm-attributable escalations).
const repos = require('../../repositories');
const DAY = 24 * 60 * 60 * 1000;

// Rules categorized as firm-side (workflow inside our control).
const FIRM_RULES = ['Awaiting review 3 days','Awaiting review 7 days','No activity 5 days','No activity 10 days','Not started within 7d of due'];
function isFirmAttributable(ruleName) { return FIRM_RULES.includes(ruleName); }

async function computeForAll() {
  const sixMonthsAgo = new Date(Date.now() - 180 * DAY).toISOString();
  const [tasks, obligations, escalations, cfg] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    repos.ObligationsRepo.list({ from: new Date(Date.now() - 180 * DAY).toISOString().slice(0,10), to: new Date().toISOString().slice(0,10), limit: 5000 }),
    repos.EscalationEventsRepo.listBetween(sixMonthsAgo, new Date().toISOString()),
    repos.WorkloadConfigRepo.getAll()
  ]);
  const tasksById = {}; tasks.forEach(t => { tasksById[t.id] = t; });
  const byClientTasks = {}; tasks.forEach(t => { (byClientTasks[t.client_external_id] = byClientTasks[t.client_external_id] || []).push(t); });
  const byClientOblig = {}; obligations.forEach(o => { (byClientOblig[o.client_external_id] = byClientOblig[o.client_external_id] || []).push(o); });

  // firm-attributable escalations per client (last 6 months)
  const firmEscByClient = {};
  escalations.filter(e => isFirmAttributable(e.rule_name)).forEach(e => {
    const t = tasksById[e.task_id]; if (!t) return;
    firmEscByClient[t.client_external_id] = (firmEscByClient[t.client_external_id] || 0) + 1;
  });

  const clients = repos.ClientsRepo.listAll();
  return clients.map(c => {
    const cid = String(c.id);
    const oblig = byClientOblig[cid] || [];
    const filed = oblig.filter(o => o.status === 'filed');
    const onTime = filed.filter(o => o.filed_at && o.filing_deadline && new Date(o.filed_at) <= new Date(o.filing_deadline + 'T23:59:59Z')).length;
    const filingTimelinessPct = oblig.length ? Math.round((onTime / oblig.length) * 100) : null;

    const completed = (byClientTasks[cid] || []).filter(t => t.status === 'completed' && t.completed_date && t.completed_date >= sixMonthsAgo);
    const slaCohort = completed.filter(t => ['met','breached'].includes(t.sla_status));
    const slaBreachRate = slaCohort.length ? slaCohort.filter(t => t.sla_status === 'breached').length / slaCohort.length : 0;

    const reviewTasks = (byClientTasks[cid] || []).filter(t => t.status === 'ready_for_review');
    const avgReviewAging = reviewTasks.length
      ? (reviewTasks.reduce((s, t) => s + Math.max(0, Math.floor((Date.now() - new Date(t.submitted_for_review_at || t.last_status_change).getTime()) / DAY)), 0) / reviewTasks.length)
      : 0;

    const firmEsc = firmEscByClient[cid] || 0;

    let score = Number(cfg.sq_base) || 100;
    const factors = [];
    if (filingTimelinessPct != null) {
      const gap = (100 - filingTimelinessPct) * (Number(cfg.sq_filing_gap_weight) || 0.4);
      score -= gap; factors.push({ key:'filing_timeliness_gap', count: filingTimelinessPct, impact: -Math.round(gap) });
    }
    if (slaCohort.length) {
      const v = slaBreachRate * (Number(cfg.sq_sla_breach_weight) || 60);
      score -= v; factors.push({ key:'sla_breach_rate', count: Math.round(slaBreachRate*100), impact: -Math.round(v) });
    }
    if (avgReviewAging > 0) {
      const v = Math.min(Number(cfg.sq_review_aging_cap) || 15, avgReviewAging * (Number(cfg.sq_review_aging_weight) || 2));
      score -= v; factors.push({ key:'review_aging_days', count: Math.round(avgReviewAging), impact: -Math.round(v) });
    }
    if (firmEsc) {
      const v = Math.min(Number(cfg.sq_firm_esc_cap) || 20, firmEsc * (Number(cfg.sq_per_firm_escalation) || 4));
      score -= v; factors.push({ key:'firm_escalations', count: firmEsc, impact: -Math.round(v) });
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const evidence = oblig.length + slaCohort.length + reviewTasks.length + firmEsc;
    return {
      clientId: cid,
      serviceQualityScore: score,
      filingTimelinessPct,
      slaBreachRate: Math.round(slaBreachRate * 100),
      avgReviewAgingDays: Math.round(avgReviewAging * 10) / 10,
      firmAttributedEscalations: firmEsc,
      confidence: evidence < (Number(cfg.portfolio_cold_start_min) || 5) ? 'low' : 'ok',
      factors
    };
  });
}

module.exports = { computeForAll, isFirmAttributable };
