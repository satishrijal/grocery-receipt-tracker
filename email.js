'use strict';
/**
 * email.js — outgoing mail via the Resend API (built-in fetch only,
 * no new dependencies). Degrades gracefully: when RESEND_API_KEY is not
 * set, sends are skipped with a clear reason instead of crashing.
 *
 * The user adds RESEND_API_KEY themselves in the Render dashboard
 * (free resend.com account, 100 emails/day). Optional FROM_EMAIL
 * overrides the default onboarding@resend.dev sender.
 */

const FROM_DEFAULT = 'onboarding@resend.dev';

function emailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

/** Public base URL for links inside emails (Render sets RENDER_EXTERNAL_URL). */
function baseUrl() {
  const port = process.env.PORT || 3000;
  return (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
}

function buildVerifyLink(base, token) {
  return `${String(base).replace(/\/+$/, '')}/verify?token=${encodeURIComponent(token)}`;
}

/**
 * Send one email. Returns { ok: true } or { ok: false, reason } where
 * reason is 'not-configured' | 'resend-error' | 'network-error'.
 */
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || FROM_DEFAULT,
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[email] Resend rejected the send:', res.status, detail.slice(0, 300));
      return { ok: false, reason: 'resend-error', detail: detail.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[email] send failed:', e.message);
    return { ok: false, reason: 'network-error' };
  }
}

function verificationEmailHtml(name, link) {
  const safeName = String(name || 'there').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2>Verify your email</h2>
      <p>Hi ${safeName}, tap the button below to verify your Gmail and finish creating your Grocery Tracker account. This link expires in 24 hours.</p>
      <p><a href="${link}" style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Verify my email</a></p>
      <p style="color:#666;font-size:13px">If the button doesn't work, paste this link into your browser:<br>${link}</p>
    </div>`;
}

function lowBalanceEmailHtml(name, remaining, appUrl) {
  const safeName = String(name || 'there').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const amt = '$' + (Number(remaining) || 0).toFixed(2);
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2>⚠️ Money is low</h2>
      <p>Hi ${safeName}, your remaining house money is down to <strong>${amt}</strong> (below $50).</p>
      <p>Add more money from your dashboard to keep shopping.</p>
      <p><a href="${appUrl}" style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Open my dashboard</a></p>
    </div>`;
}

module.exports = { emailConfigured, baseUrl, buildVerifyLink, sendEmail, verificationEmailHtml, lowBalanceEmailHtml };
