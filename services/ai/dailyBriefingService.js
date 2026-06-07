// "Today's Focus" — actionable narrative composed from existing services.
// Output is grouped by section; each bullet is a one-sentence imperative.
const repos = require('../../repositories');
const managerActionListSvc = require('../portfolio/managerActionListService');
const readinessService = require('../readinessService');
const riskService = require('../riskService');
const capacityService = require('../capacityService');
const reviewQueueService = require('../reviewQueueService');
const explain = require('./explanationEngine');

const DAY = 24 * 60 * 60 * 1000;
function daysUntil(d) { return d ? Math.floor((new Date(d).getTime() - Date.now()) / DAY) : null; }
function daysAgo(d)   { return d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null; }

async function generate() {
  const [actionList, riskData, readinessRows, capacity, reviewQueue, pendingDocs, openTasks] = await Promise.all([
    managerActionListSvc.generate(10),
    riskService.runAll(),
    readinessService.assessAllFilings(),
    capacityService.getCapacityDashboard(),
    reviewQueueService.getQueue(),
    repos.DocumentsRepo.listPending(),
    repos.TasksRepo.listOpen({ limit: 2000 })
  ]);

  const sections = [];
  const now = Date.now();
  const within = (date, days) => { const d = daysUntil(date); return d != null && d >= 0 && d <= days; };

  // 1. Top 10 clients requiring attention — reuse manager action list verbatim.
  sections.push({
    title: 'Top 10 clients requiring attention',
    items: (actionList.rows || []).slice(0, 10).map(r => ({
      headline: `${r.clientName} — action score ${r.score}.`,
      detail: (r.reasons || []).join(' · '),
      clientId: r.clientId
    }))
  });

  // 2. Critical deadlines (≤7d, not completed)
  const critical = openTasks.filter(t => within(t.due_date, 7)).sort((a,b) => (a.due_date||'').localeCompare(b.due_date||''));
  sections.push({
    title: 'Critical deadlines (≤7 days)',
    items: critical.slice(0, 10).map(t => ({
      headline: `${t.client_name} — ${(t.task_type||'').replace(/_/g,' ')} due ${t.due_date} (${daysUntil(t.due_date)}d).`,
      detail: `Status: ${t.status}. ${t.status === 'not_started' ? 'Start immediately.' : t.status === 'waiting_documents' ? 'Chase documents.' : 'Confirm on track.'}`,
      taskId: t.id, clientId: t.client_external_id
    }))
  });

  // 3. Filing risks — readiness not_ready / partially_ready with deadline ≤14d
  const filingTasksById = {}; openTasks.forEach(t => { if (t.obligation_id) filingTasksById[t.obligation_id] = t; });
  const filingRisks = (readinessRows || []).filter(r => {
    if (r.state !== 'not_ready' && r.state !== 'partially_ready') return false;
    const t = filingTasksById[r.obligationId];
    if (!t || !t.due_date) return false;
    const d = daysUntil(t.due_date); return d != null && d <= 14;
  }).slice(0, 10);
  sections.push({
    title: 'Filings at risk',
    items: filingRisks.map(r => {
      const t = filingTasksById[r.obligationId];
      return {
        headline: `${r.clientName} — ${r.workflowType.replace(/_/g,' ')} ${r.periodLabel || ''} is ${r.state.replace(/_/g,' ')}; deadline ${t.due_date} (${daysUntil(t.due_date)}d).`,
        detail: r.reason ? `Reason: ${r.reason.replace(/_/g,' ')}.` : null,
        taskId: t.id, clientId: r.clientId
      };
    })
  });

  // 4. Missing documents > 7d
  const staleDocs = (pendingDocs || []).filter(d => (daysAgo(d.requested_date) || 0) > 7)
    .sort((a,b) => (a.requested_date || '').localeCompare(b.requested_date || ''))
    .slice(0, 10);
  sections.push({
    title: 'Missing documents (>7 days)',
    items: staleDocs.map(d => ({
      headline: `${d.client_name} — "${d.document_name}" pending ${daysAgo(d.requested_date)}d.`,
      detail: `Reminders sent: ${d.reminder_count || 0}. ${(d.reminder_count || 0) >= 2 ? 'Escalate now.' : 'Send another reminder.'}`,
      docId: d.id, clientId: d.client_external_id
    }))
  });

  // 5. Pending approvals — workflow Client_Confirmation_Obtained in_progress
  const pendingApprovals = (readinessRows || []).filter(r => r.state === 'partially_ready' && r.reason === 'client_confirmation_pending').slice(0, 10);
  sections.push({
    title: 'Pending client approvals',
    items: pendingApprovals.map(r => ({
      headline: `${r.clientName} — awaiting confirmation on ${r.workflowType.replace(/_/g,' ')} ${r.periodLabel || ''}.`,
      detail: 'Follow up with the client today; this is blocking filing.',
      clientId: r.clientId
    }))
  });

  // 6. Escalation risks — current critical/high findings
  const escalationRisks = (riskData.findings || []).filter(f => f.level === 'critical' || f.level === 'high').slice(0, 10);
  sections.push({
    title: 'Escalation risks (critical & high)',
    items: escalationRisks.map(f => ({
      headline: explain.explainFinding(f) || `${f.clientName}: ${f.evidence}`,
      detail: f.recommendation || null,
      clientId: f.clientId, taskId: f.taskId
    }))
  });

  // 7. Overloaded staff
  const overloaded = (capacity.rows || []).filter(r => r.band === 'overloaded');
  sections.push({
    title: 'Overloaded staff',
    items: overloaded.map(u => ({
      headline: `${u.userName} is overloaded (${u.openTasks}/${u.capacity || '?'} open tasks, ratio ${u.workloadRatio}).`,
      detail: 'Rebalance: see Team Analytics → Workload for one-click recommendations.',
      userId: u.userId
    }))
  });

  // 8. Review queue alarms
  const alarmingReviews = (reviewQueue.queue || []).filter(r => r.aging === 'alarm').slice(0, 10);
  if (alarmingReviews.length) {
    sections.push({
      title: 'Review queue alarms (>1 week)',
      items: alarmingReviews.map(r => ({
        headline: `${r.client} — ${r.taskType.replace(/_/g,' ')} has been awaiting review ${r.ageDays}d.`,
        detail: 'Assign a reviewer or escalate to admin.',
        taskId: r.id, clientId: null
      }))
    });
  }

  return { generatedAt: new Date().toISOString(), sections };
}

module.exports = { generate };
