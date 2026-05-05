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

module.exports = { sendInviteEmail: sendInviteEmail, sendResetEmail: sendResetEmail };
