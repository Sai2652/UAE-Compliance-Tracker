async function sendViaResend(to, subject, html) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };
  var from = process.env.EMAIL_FROM || 'UAE Compliance Tracker <onboarding@resend.dev>';
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to, subject: subject, html: html }),
    });
    var data = await res.json();
    if (res.ok) { console.log('Email sent to:', to); return { success: true }; }
    else { console.error('Resend error:', data); return { success: false, error: data.message || 'Send failed' }; }
  } catch (err) { console.error('Email error:', err.message); return { success: false, error: err.message }; }
}

function inviteHtml(name, url) {
  return '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px"><div style="background:linear-gradient(135deg,#3d7aed,#22c55e);padding:24px;border-radius:12px 12px 0 0;text-align:center"><h1 style="color:white;margin:0;font-size:20px">UAE Compliance Tracker</h1><p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Team Invitation</p></div><div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px"><p style="color:#1f2937">Hi <strong>' + name + '</strong>,</p><p style="color:#4b5563">You have been invited to join the UAE Compliance Tracker.</p><div style="text-align:center;margin:24px 0"><a href="' + url + '" style="background:#3d7aed;color:white;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Accept Invitation</a></div><p style="font-size:12px;color:#9ca3af;text-align:center">Link expires in 48 hours.<br>' + url + '</p></div></div>';
}

function resetHtml(name, url) {
  return '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px"><div style="background:linear-gradient(135deg,#3d7aed,#f59e0b);padding:24px;border-radius:12px 12px 0 0;text-align:center"><h1 style="color:white;margin:0;font-size:20px">UAE Compliance Tracker</h1><p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Password Reset</p></div><div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px"><p style="color:#1f2937">Hi <strong>' + name + '</strong>,</p><p style="color:#4b5563">Click below to reset your password.</p><div style="text-align:center;margin:24px 0"><a href="' + url + '" style="background:#f59e0b;color:#1f2937;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Reset Password</a></div><p style="font-size:12px;color:#9ca3af;text-align:center">Link expires in 2 hours.<br>' + url + '</p></div></div>';
}

async function sendInviteEmail(to, name, url) { return sendViaResend(to, "You're invited to UAE Compliance Tracker", inviteHtml(name, url)); }
async function sendResetEmail(to, name, url) { return sendViaResend(to, 'Password Reset - UAE Compliance Tracker', resetHtml(name, url)); }

// ---------------------------------------------------------------
// Notification template framework (modular, expandable).
// Each template returns { subject, html }. Add new templates here.
// ---------------------------------------------------------------
function shell(headerColor, headerLine1, headerLine2, bodyHtml) {
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">'
    + '<div style="background:' + headerColor + ';padding:20px;border-radius:12px 12px 0 0;text-align:center">'
    + '<h1 style="color:white;margin:0;font-size:18px">' + headerLine1 + '</h1>'
    + '<p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px">' + headerLine2 + '</p>'
    + '</div>'
    + '<div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">' + bodyHtml + '</div>'
    + '</div>';
}

function taskLine(task) {
  return '<div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:8px 0">'
    + '<div style="font-weight:700;color:#1f2937">' + (task.client_name || '') + ' — ' + (task.task_type || '').replace(/_/g,' ') + '</div>'
    + '<div style="font-size:12px;color:#4b5563;margin-top:4px">Status: ' + (task.status || '') + ' · Due: ' + (task.due_date || '—') + (task.priority_score != null ? ' · Priority: ' + task.priority_score : '') + '</div>'
    + '</div>';
}

const templates = {
  escalation_owner: function(name, task, rule) {
    return {
      subject: '[Escalation] ' + (task.client_name || '') + ' — ' + (task.task_type || '').replace(/_/g, ' '),
      html: shell('linear-gradient(135deg,#ef4444,#f59e0b)', 'Task Escalated', rule.name,
        '<p>Hi <strong>' + (name || '') + '</strong>,</p>'
        + '<p>One of your tasks just hit the escalation rule: <strong>' + (rule.name || '') + '</strong>.</p>'
        + taskLine(task)
        + '<p style="font-size:12px;color:#6b7280">Please update the task status or add a comment to clear this escalation.</p>')
    };
  },
  escalation_admin: function(name, task, rule) {
    return {
      subject: '[Admin] Escalation: ' + (task.client_name || '') + ' — ' + (task.task_type || '').replace(/_/g, ' '),
      html: shell('linear-gradient(135deg,#7c3aed,#ef4444)', 'Escalation Alert', rule.name,
        '<p>Hi <strong>' + (name || 'Admin') + '</strong>,</p>'
        + '<p>The following task was escalated by rule <strong>' + (rule.name || '') + '</strong> (severity ' + (rule.severity || 1) + '):</p>'
        + taskLine(task)
        + '<p style="font-size:12px;color:#6b7280">Owner: ' + (task.assigned_user_name || 'Unassigned') + '</p>')
    };
  },
  admin_digest: function(name, payload) {
    var overdueHtml = (payload.overdue || []).slice(0, 20).map(taskLine).join('');
    var blockedHtml = (payload.blocked || []).slice(0, 20).map(taskLine).join('');
    return {
      subject: '[Admin Digest] ' + (payload.date || '') + ' — '
        + (payload.overdue || []).length + ' overdue, '
        + (payload.blocked || []).length + ' blocked',
      html: shell('linear-gradient(135deg,#1e40af,#0ea5e9)', 'Daily Admin Digest', payload.date || '',
        '<p>Hi <strong>' + (name || 'Admin') + '</strong>,</p>'
        + '<h3 style="color:#ef4444;margin-top:16px">Overdue (' + (payload.overdue || []).length + ')</h3>'
        + (overdueHtml || '<p style="color:#6b7280;font-size:12px">No overdue tasks. 🎉</p>')
        + '<h3 style="color:#f59e0b;margin-top:16px">Blocked / Escalated (' + (payload.blocked || []).length + ')</h3>'
        + (blockedHtml || '<p style="color:#6b7280;font-size:12px">No blocked tasks.</p>'))
    };
  },
  task_assigned: function(name, task) {
    return {
      subject: '[New Task] ' + (task.client_name || '') + ' — ' + (task.task_type || '').replace(/_/g, ' '),
      html: shell('linear-gradient(135deg,#3d7aed,#22c55e)', 'New Task Assigned', task.task_type || '',
        '<p>Hi <strong>' + (name || '') + '</strong>,</p>'
        + '<p>You have been assigned a new task.</p>' + taskLine(task))
    };
  },
  review_ready: function(name, task) {
    return {
      subject: '[Review] ' + (task.client_name || '') + ' — ready for review',
      html: shell('linear-gradient(135deg,#3d7aed,#8b5cf6)', 'Task Ready for Review', task.task_type || '',
        '<p>Hi <strong>' + (name || 'Admin') + '</strong>,</p>'
        + '<p>A task is awaiting your review.</p>' + taskLine(task))
    };
  }
};

async function sendTemplate(templateKey, to, ...args) {
  if (!templates[templateKey]) return { success: false, error: 'unknown_template' };
  var rendered = templates[templateKey].apply(null, args);
  return sendViaResend(to, rendered.subject, rendered.html);
}

async function sendEscalationOwnerEmail(to, name, task, rule) { return sendTemplate('escalation_owner', to, name, task, rule); }
async function sendEscalationAdminEmail(to, name, task, rule) { return sendTemplate('escalation_admin', to, name, task, rule); }
async function sendAdminDigest(to, name, payload)             { return sendTemplate('admin_digest', to, name, payload); }
async function sendTaskAssignedEmail(to, name, task)          { return sendTemplate('task_assigned', to, name, task); }
async function sendReviewReadyEmail(to, name, task)           { return sendTemplate('review_ready', to, name, task); }

module.exports = {
  sendInviteEmail: sendInviteEmail,
  sendResetEmail: sendResetEmail,
  sendEscalationOwnerEmail: sendEscalationOwnerEmail,
  sendEscalationAdminEmail: sendEscalationAdminEmail,
  sendAdminDigest: sendAdminDigest,
  sendTaskAssignedEmail: sendTaskAssignedEmail,
  sendReviewReadyEmail: sendReviewReadyEmail,
  sendTemplate: sendTemplate,
  templates: templates
};
