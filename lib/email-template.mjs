/**
 * lib/email-template.mjs: the look of every email the app sends (invites, password resets).
 * Table layout + inline styles: what Gmail, Outlook and Apple Mail all render. The logo travels inside the
 * email as an inline attachment (cid:), so it shows even before the site is public.
 *
 *   const { html, text, attachments } = renderEmail({ preheader, heading, paragraphs, button: { label, url }, note, reason })
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGO = fs.readFileSync(path.join(ROOT, 'public', 'brand', 'rejekt-logo-email.png')).toString('base64');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export function renderEmail({ preheader = '', heading, paragraphs = [], button = null, note = '', reason = '' }) {
  const site = process.env.SITE_URL || 'https://rejekt.ai';
  const support = process.env.SUPPORT_EMAIL || 'support@rejekt.ai';
  const p = (t) => `<p style="margin:0 0 16px;font:16px/1.6 ${FONT};color:#3B3B3B">${esc(t)}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#F4F4F2">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F4F4F2"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px">
    <tr><td style="padding:0 4px 20px"><img src="cid:rejekt-logo" width="132" alt="Rejekt.ai" style="display:block;width:132px;height:auto;border:0"></td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid #E4E4E2;border-radius:14px;padding:36px 36px 28px">
      <h1 style="margin:0 0 18px;font:700 24px/1.25 ${FONT};color:#111111;letter-spacing:-0.3px">${esc(heading)}</h1>
      ${paragraphs.map(p).join('')}
      ${button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr><td style="border-radius:10px;background:#17382B">
        <a href="${esc(button.url)}" style="display:inline-block;padding:13px 24px;font:600 16px/1 ${FONT};color:#FFFFFF;text-decoration:none;border-radius:10px">${esc(button.label)}</a></td></tr></table>
      <p style="margin:0 0 6px;font:13px/1.5 ${FONT};color:#6A6A6A">If the button doesn't work, copy this link into your browser:</p>
      <p style="margin:0 0 20px;font:13px/1.5 ${FONT};word-break:break-all"><a href="${esc(button.url)}" style="color:#17382B">${esc(button.url)}</a></p>` : ''}
      ${note ? `<p style="margin:0;padding-top:18px;border-top:1px solid #EFEFED;font:14px/1.6 ${FONT};color:#6A6A6A">${esc(note)}</p>` : ''}
    </td></tr>
    <tr><td style="padding:22px 8px 0;font:12px/1.6 ${FONT};color:#8A8A8A;text-align:center">
      ${reason ? `${esc(reason)}<br>` : ''}Questions? Reply to this email or write to <a href="mailto:${esc(support)}" style="color:#6A6A6A">${esc(support)}</a>.<br>
      <a href="${esc(site)}" style="color:#6A6A6A;text-decoration:none">Rejekt.ai</a> &nbsp;·&nbsp;
      <a href="${esc(site)}/terms" style="color:#6A6A6A">Terms</a> &nbsp;·&nbsp; <a href="${esc(site)}/privacy" style="color:#6A6A6A">Privacy</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [heading, '', ...paragraphs.flatMap(t => [t, '']),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []), ...(note ? [note, ''] : []),
    '--', reason, `Questions? Reply to this email or write to ${support}.`, `Rejekt.ai · ${site}`].filter(l => l !== undefined).join('\n');

  return { html, text, attachments: [{ filename: 'rejekt-logo.png', content: LOGO, content_id: 'rejekt-logo' }] };
}

// Self-check: node lib/email-template.mjs
if (process.argv[1]?.endsWith('email-template.mjs')) {
  const e = renderEmail({ heading: 'Hi <there>', paragraphs: ['One', 'Two'], button: { label: 'Go', url: 'https://x.test/a?b=1&c=2' }, note: 'Note', reason: 'Because.' });
  console.assert(e.html.includes('Hi &lt;there&gt;') && e.html.includes('cid:rejekt-logo') && e.html.includes('b=1&amp;c=2'), 'html');
  console.assert(e.text.includes('Go: https://x.test/a?b=1&c=2') && e.attachments[0].content.length > 1000, 'text/logo');
  console.log('ok');
}
