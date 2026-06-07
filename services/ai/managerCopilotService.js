// Manager Copilot — six canned questions, deterministic answers.
// Each question maps to existing services + explanation engine for sentences.

const repos = require('../../repositories');
const riskService = require('../riskService');
const capacityService = require('../capacityService');
const reviewQueueService = require('../reviewQueueService');
const clientReadinessService = require('../clientReadinessService');
const managerActionListSvc = require('../portfolio/managerActionListService');
const explain = require('./explanationEngine');

const QUESTIONS = {
  attention_today: 'Which clients need attention today?',
  escalation_likely: 'Which clients are most likely to cause escalation?',
  awaiting_approval: 'Which clients are waiting for approvals?',
  deadlines_at_risk: 'Which deadlines are at risk?',
  overloaded_users: 'Which employees are overloaded?',
  review_first: 'Which filings should be reviewed first?'
};

async function answer(questionKey) {
  switch (questionKey) {
    case 'attention_today': {
      const list = await managerActionListSvc.generate(10);
      return {
        question: QUESTIONS.attention_today,
        answer: list.rows.length
          ? `${list.rows.length} client(s) need attention today.`
          : 'No clients require immediate attention.',
        items: list.rows.map(r => ({
          clientId: r.clientId, clientName: r.clientName,
          score: r.score, tier: r.tier, riskBand: r.riskBand,
          sentence: `${r.clientName} (Tier ${r.tier}, ${r.riskBand} risk) — action score ${r.score}. ${(r.reasons||[]).join(' · ')}.`
        }))
      };
    }
    case 'escalation_likely': {
      const data = await riskService.runAll();
      const scores = riskService.computeClientScores(data.findings, data.config, repos.ClientsRepo.listAll());
      const top = scores.filter(s => s.band !== 'green').slice(0, 10);
      return {
        question: QUESTIONS.escalation_likely,
        answer: top.length ? `${top.length} client(s) are above the green band.` : 'No clients above the green band.',
        items: top.map(s => ({
          clientId: s.clientId, clientName: s.clientName,
          score: s.score, band: s.band,
          sentence: `${s.clientName} — escalation score ${s.score} (${s.band}). Critical: ${s.totals.critical}, High: ${s.totals.high}.`
        }))
      };
    }
    case 'awaiting_approval': {
      const readinessData = await clientReadinessService.getAllClientReadiness();
      const waiting = (readinessData.clients || []).filter(r => r.state === 'awaiting_client_approval');
      return {
        question: QUESTIONS.awaiting_approval,
        answer: waiting.length ? `${waiting.length} client(s) are awaiting confirmation.` : 'No pending client approvals.',
        items: waiting.slice(0, 25).map(r => ({
          clientId: r.clientId, clientName: r.clientName,
          tier: r.tier, owner: r.owner,
          sentence: `${r.clientName} (Tier ${r.tier}) — owner ${r.owner || 'unassigned'}. Follow up with the client to obtain confirmation.`
        }))
      };
    }
    case 'deadlines_at_risk': {
      const tasks = await repos.TasksRepo.listOpen({ limit: 3000 });
      const atRisk = tasks.filter(t => ['at_risk','likely_breach','breached'].includes(t.sla_status))
        .sort((a,b) => (a.due_date || '').localeCompare(b.due_date || ''))
        .slice(0, 25);
      return {
        question: QUESTIONS.deadlines_at_risk,
        answer: atRisk.length ? `${atRisk.length} task(s) flagged at or beyond SLA risk.` : 'No SLA-flagged tasks.',
        items: atRisk.map(t => ({
          taskId: t.id, clientName: t.client_name,
          sentence: `${t.client_name} — ${(t.task_type||'').replace(/_/g,' ')} due ${t.due_date}, SLA: ${t.sla_status}. Owner: ${t.assigned_user_name || 'unassigned'}.`
        }))
      };
    }
    case 'overloaded_users': {
      const cap = await capacityService.getCapacityDashboard();
      const over = (cap.rows || []).filter(r => r.band === 'overloaded');
      return {
        question: QUESTIONS.overloaded_users,
        answer: over.length ? `${over.length} team member(s) overloaded.` : 'No one is overloaded.',
        items: over.map(u => ({
          userId: u.userId, userName: u.userName,
          sentence: `${u.userName} — ${u.openTasks}/${u.capacity || '?'} open tasks (ratio ${u.workloadRatio}). Reassign to spare-capacity users.`
        }))
      };
    }
    case 'review_first': {
      const q = await reviewQueueService.getQueue();
      const top = (q.oldest || []).slice(0, 10);
      return {
        question: QUESTIONS.review_first,
        answer: top.length ? `Top ${top.length} review(s) by age.` : 'Review queue is empty.',
        items: top.map(r => ({
          taskId: r.id, clientName: r.client,
          sentence: `${r.client} — ${(r.taskType||'').replace(/_/g,' ')} (priority ${r.priority}) has been waiting ${r.ageDays}d. Aging: ${r.aging}.`
        }))
      };
    }
    default:
      return { question: 'Unknown question', answer: null, items: [] };
  }
}

module.exports = { QUESTIONS, answer };
