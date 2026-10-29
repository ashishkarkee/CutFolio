// CutFolio email reminders: one Lambda, three jobs.
//
// 1. EventBridge Scheduler runs it every 15 minutes ({"job":"reminders"}) and it
//    emails a 24-hour reminder for every booking that starts in the next day.
// 2. The app calls its Function URL right after a booking is made or moved
//    (action "confirm") and when the barber messages overdue clients ("nudge").
//    Those calls carry the barber's Supabase login token, which is checked
//    before anything is read or sent.
// 3. Clients open /unsubscribe from the link at the bottom of every email.
//
// Emails go out through Gmail (free) or Amazon SES (needs a domain).
// Every email sent is logged in the Supabase "emails" table, which is how the
// app shows what was sent on each profile.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { LambdaClient, GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import nodemailer from 'nodemailer';

const env = process.env;
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = env.SUPABASE_SECRET_KEY || '';
const FROM = env.FROM_EMAIL;
const REPLY_TO = env.REPLY_TO_EMAIL || '';
const BARBER = env.BARBER_NAME || 'Lucas';
const INSTAGRAM = (env.INSTAGRAM_HANDLE || 'lucasfadez').replace(/^@/, '');
const INSTAGRAM_URL = `https://www.instagram.com/${INSTAGRAM}/`;
const DM = `Feel free to message me on Instagram${INSTAGRAM ? ` (@${INSTAGRAM})` : ''}`;
const AUTOMATED = `This is an automated message, so replies to this email aren’t read. Message me on Instagram${INSTAGRAM ? ` (@${INSTAGRAM})` : ''} instead.`;
const ADDRESS = env.SHOP_ADDRESS || '';
const ZONE = env.SHOP_TIME_ZONE || 'America/New_York';

// With a Gmail app password, emails go out through that Gmail account (free,
// and they pass Gmail's sender checks). Without one, they go through SES,
// which needs a domain of your own to stay out of spam.
const GMAIL_PASSWORD = (env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const gmail = GMAIL_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: FROM, pass: GMAIL_PASSWORD } })
  : null;
const ses = new SESv2Client({});
const lambda = new LambdaClient({});

export const handler = async (event, context) => {
  if (event?.job === 'reminders') return sendDueReminders(context);

  const http = event?.requestContext?.http;
  if (!http) return { error: 'unknown event' };
  try {
    if (http.path === '/unsubscribe') return await unsubscribe(event);
    if (http.method !== 'POST') return reply(404, { error: 'Not found' });

    const user = await signedInUser(event.headers?.authorization);
    if (!user) return reply(401, { error: 'Sign in again' });
    const body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '{}');
    if (body.action === 'confirm') return reply(200, await confirm(user.id, body.appointmentId, context));
    if (body.action === 'nudge') return reply(200, await nudge(user.id, body, context));
    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return reply(500, { error: err.message || 'Something went wrong' });
  }
};

// ---------- Jobs ----------

// Bookings starting within 24 hours get one reminder each. A booking confirmed
// less than a day before it starts doesn't need one, so it's skipped.
async function sendDueReminders(context) {
  const now = new Date();
  const until = new Date(now.getTime() + 24 * 3600e3);
  const appts = await db('GET', `appointments?select=id,owner,client_id,starts_at,minutes,clients(name,email,reminders)` +
    `&cut_id=is.null&starts_at=gt.${now.toISOString()}&starts_at=lte.${until.toISOString()}`);
  const results = { checked: appts.length, sent: 0, skipped: 0, failed: 0 };
  for (const a of appts) {
    const c = a.clients;
    if (!c?.email || !c.reminders) { results.skipped++; continue; }
    const dayBefore = new Date(new Date(a.starts_at).getTime() - 24 * 3600e3).toISOString();
    const recent = await db('GET', `emails?select=id&appointment_id=eq.${a.id}&kind=eq.confirmation` +
      `&starts_at=eq.${encodeURIComponent(a.starts_at)}&sent_at=gt.${dayBefore}&limit=1`);
    if (recent.length) { results.skipped++; continue; }
    const when = describe(a.starts_at, now);
    const outcome = await sendAndLog({
      owner: a.owner, clientId: a.client_id, appointmentId: a.id, kind: 'reminder', startsAt: a.starts_at, to: c.email,
      subject: 'Haircut reminder',
      lines: [
        `Hi ${firstName(c.name)},`,
        `You’re confirmed for a haircut ${when.relative} at ${when.time}!`,
        `That’s ${when.date}${ADDRESS ? ` at ${ADDRESS}` : ''}.`,
        `${DM} if you need to change anything.`,
      ],
    }, context);
    results[outcome]++;
  }
  console.log(JSON.stringify(results));
  return results;
}

// Sent by the app right after a booking is made or moved.
async function confirm(owner, appointmentId, context) {
  if (!isUuid(appointmentId)) throw new Error('Missing booking');
  const [a] = await db('GET', `appointments?select=id,client_id,starts_at,minutes,clients(name,email,reminders)&id=eq.${appointmentId}&owner=eq.${owner}`);
  if (!a) throw new Error('Booking not found');
  const c = a.clients;
  if (!c?.email) return { sent: false, reason: 'no email' };
  if (!c.reminders) return { sent: false, reason: 'unsubscribed' };
  const before = await db('GET', `emails?select=id&appointment_id=eq.${a.id}&kind=eq.confirmation&limit=1`);
  const when = describe(a.starts_at, new Date());
  const moved = before.length > 0;
  const email = {
    owner, clientId: a.client_id, appointmentId: a.id, kind: 'confirmation', startsAt: a.starts_at, to: c.email,
    subject: moved ? 'Haircut moved' : 'Haircut confirmed',
    lines: [
      `Hi ${firstName(c.name)},`,
      moved ? `Your haircut has moved. The new time is ${when.long}.` : `You’re booked for a haircut on ${when.long}.`,
      ADDRESS ? `Where: ${ADDRESS}` : '',
      `I’ll send a reminder the day before. ${DM} if you need to change anything.`,
    ],
  };
  const outcome = await sendAndLog(email, context);
  return { sent: outcome === 'sent', email: email.row };
}

// "It's been a while" emails to overdue clients, with the barber's openings.
async function nudge(owner, { clientIds, openings, note }, context) {
  if (!Array.isArray(clientIds) || !clientIds.length || clientIds.length > 50 || !clientIds.every(isUuid)) throw new Error('Pick up to 50 clients');
  if (!Array.isArray(openings) || !openings.length || openings.length > 10) throw new Error('Add at least one opening');
  const slots = openings.map(s => String(s).slice(0, 60).trim()).filter(Boolean);
  const extra = String(note || '').slice(0, 500).trim();
  const ids = clientIds.join(',');
  const clients = await db('GET', `clients?select=id,name,email,reminders&id=in.(${ids})&owner=eq.${owner}`);
  const cuts = await db('GET', `cuts?select=client_id,date&client_id=in.(${ids})&owner=eq.${owner}&order=date.desc`);
  const lastCut = {};
  for (const c of cuts) lastCut[c.client_id] ||= c.date;

  const results = [];
  for (const c of clients) {
    if (!c.email || !c.reminders) { results.push({ clientId: c.id, sent: false, reason: c.email ? 'unsubscribed' : 'no email' }); continue; }
    const last = lastCut[c.id] ? dateLabel(lastCut[c.id]) : '';
    const email = {
      owner, clientId: c.id, kind: 'nudge', to: c.email,
      subject: 'Booking reminder',
      lines: [
        `Hi ${firstName(c.name)},`,
        last ? `Your last cut was on ${last}, so you’re probably about due.` : `It’s been a while, so you’re probably about due.`,
        `Here’s when I have openings:`,
        { list: slots },
        extra,
        `${DM} with the time that works and I’ll book you in.`,
      ],
    };
    const outcome = await sendAndLog(email, context);
    results.push({ clientId: c.id, sent: outcome === 'sent', email: email.row });
  }
  return { results };
}

async function unsubscribe(event) {
  const q = event.queryStringParameters || {};
  const page = (title, text) => ({
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>` +
      `<body style="font:17px/1.5 -apple-system,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center">` +
      `<h1 style="font-size:24px">${esc(title)}</h1><p>${esc(text)}</p></body>`,
  });
  if (!isUuid(q.c) || !q.t || !safeEqual(q.t, unsubToken(q.c))) return page('Link not recognized', 'This unsubscribe link is incomplete. Reply to any email and we’ll take you off the list.');
  await db('PATCH', `clients?id=eq.${q.c}`, { reminders: false });
  return page('You’re unsubscribed', `You won’t get any more emails from ${BARBER}.`);
}

// ---------- Email ----------

// Claim a log row, send, then record the SES message id. If the send fails
// the row is removed, so the app never shows an email that didn't go out.
async function sendAndLog(e, context) {
  let row;
  try {
    [row] = await db('POST', 'emails', {
      owner: e.owner, client_id: e.clientId, appointment_id: e.appointmentId || null,
      kind: e.kind, starts_at: e.startsAt || null, to_email: e.to,
    });
  } catch (err) {
    if (err.code === '23505') return 'skipped'; // another run already sent this reminder
    throw err;
  }
  try {
    const unsub = await unsubLink(e.clientId, context);
    const res = await send(e.to, e.subject, e.lines, unsub);
    [row] = await db('PATCH', `emails?id=eq.${row.id}`, { ses_message_id: res.MessageId, sent_at: new Date().toISOString() });
    e.row = row;
    return 'sent';
  } catch (err) {
    console.error(`Send to ${e.clientId} failed:`, err);
    await db('DELETE', `emails?id=eq.${row.id}`).catch(() => {});
    if (e.kind === 'reminder') return 'failed';
    throw err;
  }
}

async function send(to, subject, lines, unsub) {
  const parts = lines.filter(Boolean);
  const sign = BARBER;
  const text = parts.map(p => p.list ? p.list.map(s => `  • ${s}`).join('\n') : p).join('\n\n') +
    `\n\n${sign}\n${INSTAGRAM_URL}\n\n${AUTOMATED}\nDon’t want these emails? ${unsub}`;
  const html = `<div style="font:16px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:520px">` +
    parts.map(p => p.list
      ? `<ul style="padding-left:20px;margin:0 0 14px">${p.list.map(s => `<li style="margin:4px 0"><b>${esc(s)}</b></li>`).join('')}</ul>`
      : `<p style="margin:0 0 14px">${esc(p)}</p>`).join('') +
    `<p style="margin:22px 0 0">${esc(sign)}<br><a href="${esc(INSTAGRAM_URL)}" style="color:#1a1a1a">instagram.com/${esc(INSTAGRAM)}</a></p>` +
    `<p style="margin:28px 0 0;font-size:12px;color:#888">${esc(AUTOMATED)}<br>Don’t want these emails? <a href="${esc(unsub)}" style="color:#888">Unsubscribe</a></p></div>`;
  const unsubHeaders = { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  if (gmail) {
    const info = await gmail.sendMail({
      from: { name: BARBER.replace(/[<>",]/g, ''), address: FROM },
      to, replyTo: REPLY_TO || undefined, subject, text, html, headers: unsubHeaders,
    });
    return { MessageId: info.messageId };
  }
  const cmd = () => ses.send(new SendEmailCommand({
    FromEmailAddress: `${BARBER.replace(/[<>",]/g, '')} <${FROM}>`,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: REPLY_TO ? [REPLY_TO] : undefined,
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
        Headers: Object.entries(unsubHeaders).map(([Name, Value]) => ({ Name, Value })),
      },
    },
  }));
  try {
    return await cmd();
  } catch (err) {
    // The SES sandbox allows one email a second; wait and try once more
    if (err.name !== 'TooManyRequestsException' && err.name !== 'ThrottlingException') throw err;
    await new Promise(r => setTimeout(r, 1100));
    return cmd();
  }
}

// ---------- Unsubscribe links ----------

const unsubToken = clientId => createHmac('sha256', SUPABASE_KEY).update('unsubscribe:' + clientId).digest('base64url').slice(0, 22);
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
let baseUrl = env.PUBLIC_URL || '';
async function unsubLink(clientId, context) {
  if (!baseUrl) {
    const cfg = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: context.functionName }));
    baseUrl = cfg.FunctionUrl;
  }
  return `${baseUrl.replace(/\/$/, '')}/unsubscribe?c=${clientId}&t=${unsubToken(clientId)}`;
}

// ---------- Supabase ----------

// The secret key bypasses row-level security, so every query that runs for
// the app also filters on the signed-in barber's id.
async function db(method, path, body) {
  const headers = { apikey: SUPABASE_KEY, 'content-type': 'application/json', prefer: 'return=representation' };
  // Older JWT-style service_role keys also go in Authorization; new sb_secret_ keys must not
  if (!SUPABASE_KEY.startsWith('sb_')) headers.authorization = `Bearer ${SUPABASE_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(json?.message || `Supabase ${res.status}`);
    err.code = json?.code;
    throw err;
  }
  return json;
}

async function signedInUser(authorization) {
  const token = (authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : null;
}

// ---------- Helpers ----------

const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const isUuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'there';
const fmt = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, ...opts }).format(new Date(d));
const dayKey = d => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const dateLabel = d => fmt(d, { month: 'long', day: 'numeric' });

// Times are written in the shop's time zone: "2 PM" or "2:30 PM", and
// "today" / "tomorrow" / "on Saturday" relative to now.
export function describe(startsAt, now) {
  const time = fmt(startsAt, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  const tomorrow = new Date(new Date(now).getTime() + 864e5);
  const relative = dayKey(startsAt) === dayKey(now) ? 'today' : dayKey(startsAt) === dayKey(tomorrow) ? 'tomorrow' : 'on ' + fmt(startsAt, { weekday: 'long' });
  const short = `${fmt(startsAt, { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
  const date = fmt(startsAt, { weekday: 'long', month: 'long', day: 'numeric' });
  return { time, relative, date, short, long: `${date} at ${time}` };
}
