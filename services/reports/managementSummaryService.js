// Monthly management summary — one screen, the firm-level numbers.
const repos = require('../../repositories');
const periodHelper = require('./periodHelper');
const vatct = require('./complianceReportService');
const escSvc = require('./escalationAnalyticsService');
const employeeSvc = require('./employeePerformanceService');
const attentionSvc = require('./attentionRequiredService');
const clientReadinessService = require('../clientReadinessService');
const riskService = require('../riskService');

async function generate(month) {
  const b = periodHelper.resolveBounds('month', month);

  const [tasks, vat, ct, escReport, empReport, readinessData, riskData, attention] = await Promise.all([
    repos.TasksRepo.listAll({ limit: 5000 }),
    vatct.vat.generate('month', b.value),
    vatct.ct.generate('month', b.value),
    escSvc.generate('month', b.value),
    employeeSvc.generate('month', b.value),
    clientReadinessService.getAllClientReadiness(),
    riskService.runAll(),
    attentionSvc.generate(10)
  ]);

  const clients = repos.ClientsRepo.listAll();
  const activeClients = clients.filter(c => tasks.some(t => String(t.client_external_id) === String(c.id) && t.last_activity_at && t.last_activity_at >= b.fromISO)).length;
  const open = tasks.filter(t => t.status !== 'completed');
  const overdue = open.filter(t => t.due_date && new Date(t.due_date).getTime() < Date.now());
  const pendingReviews = open.filter(t => t.status === 'ready_for_review');
  const openEscalations = (await repos.EscalationEventsRepo.listOpen()).length;
  const scores = riskService.computeClientScores(riskData.findings, riskData.config, clients);
  const highRiskClients = scores.filter(s => s.band === 'red').length;

  // Filing completion across VAT+CT
  const totalDue = (vat.totals.due || 0) + (ct.totals.due || 0);
  const totalFiled = (vat.totals.filed || 0) + (ct.totals.filed || 0);
  const filingCompletionRate = totalDue ? Math.round((totalFiled / totalDue) * 100) : null;

  const activeUsers = repos.UsersRepo.listActive().length;
  const completedInPeriod = tasks.filter(t => t.status === 'completed' && t.completed_date && t.completed_date >= b.fromISO && t.completed_date < b.toISO).length;
  const teamProductivity = activeUsers ? Math.round((completedInPeriod / activeUsers) * 10) / 10 : null;

  return {
    meta: b,
    headline: {
      totalClients: clients.length,
      activeClients,
      filingCompletionRate,
      teamProductivity,
      highRiskClients,
      openEscalations,
      overdueWork: overdue.length,
      pendingReviews: pendingReviews.length,
      completedInPeriod
    },
    vat: vat.totals,
    ct: ct.totals,
    escalations: escReport.totals,
    escalationCategories: escReport.categories,
    topPerformers: empReport.rows.slice(0, 5),
    readinessCounts: readinessData.counts,
    attentionRequired: attention.rows
  };
}

module.exports = { generate };
