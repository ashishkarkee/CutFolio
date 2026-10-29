// CutFolio: a private app for one barber. Data lives in Supabase (Postgres +
// a private Storage bucket); the signed-in barber is the only one who can read it.

// ---------- Supabase ----------
const CONFIG = window.CUTFOLIO_CONFIG || {};
const sb = CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && CONFIG.loginEmail
  ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
const BUCKET = 'photos';
const URL_TTL = 60 * 60 * 24; // signed photo links last a day; refreshed on each app load

// Everything is loaded once after sign-in and kept in memory; writes go to
// Supabase first and then update this copy.
const data = { clients: [], cuts: [], photos: [], appts: [], emails: [] };
const photoUrls = {}; // storage path -> signed URL
let user = null;
let scheduleReady = true; // false until the appointments table exists in Supabase
let emailReady = true;    // false until supabase/reminders.sql has been run

async function fetchAll(table) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await sb.from(table).select('*').order('created_at').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}
const toClient = r => ({ id: r.id, name: r.name, createdAt: r.created_at, email: r.email || '', reminders: r.reminders !== false });
const toCut = r => ({ id: r.id, clientId: r.client_id, date: new Date(r.date).toISOString(), price: Number(r.price), minutes: r.minutes, style: r.style, notes: r.notes });
const toPhoto = r => ({ id: r.id, cutId: r.cut_id, clientId: r.client_id, path: r.path, thumbPath: r.thumb_path });
const toEmail = r => ({ id: r.id, clientId: r.client_id, apptId: r.appointment_id, kind: r.kind, startsAt: r.starts_at, to: r.to_email, sentAt: r.sent_at });
const toAppt = r => ({ id: r.id, clientId: r.client_id, start: new Date(r.starts_at).toISOString(), minutes: r.minutes, notes: r.notes, cutId: r.cut_id });

async function loadData() {
  const [clients, cuts, photos] = await Promise.all([fetchAll('clients'), fetchAll('cuts'), fetchAll('photos')]);
  data.clients = clients.map(toClient);
  data.cuts = cuts.map(toCut);
  data.photos = photos.map(toPhoto);
  // The schedule is optional: if its table hasn't been added yet, the rest of the app still works
  try {
    data.appts = (await fetchAll('appointments')).map(toAppt);
    scheduleReady = true;
  } catch {
    data.appts = []; scheduleReady = false;
  }
  try {
    data.emails = (await fetchAll('emails')).map(toEmail);
    emailReady = true;
  } catch {
    data.emails = []; emailReady = false;
  }
  await signPaths(data.photos.flatMap(p => [p.path, p.thumbPath]));
}
async function signPaths(paths) {
  const todo = paths.filter(p => p && !photoUrls[p]);
  for (let i = 0; i < todo.length; i += 100) {
    const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrls(todo.slice(i, i + 100), URL_TTL);
    if (error) throw error;
    for (const s of signed) if (s.signedUrl) photoUrls[s.path] = s.signedUrl;
  }
}
const thumbUrl = p => photoUrls[p.thumbPath] || photoUrls[p.path] || '';
const fullUrl = p => photoUrls[p.path] || photoUrls[p.thumbPath] || '';

// ---------- Email reminders (AWS Lambda + SES, see aws/README.md) ----------
const emailLive = () => emailReady && !!CONFIG.remindersUrl;
const canEmail = client => emailLive() && !!client?.email && client.reminders;
// Calls the reminders Lambda with the barber's login token, which it checks
async function callReminders(body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(CONFIG.remindersUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Email service error ${res.status}`);
  return out;
}
// Send a booking confirmation if the client has reminders on. Never blocks the booking.
async function confirmBooking(appt) {
  const client = data.clients.find(c => c.id === appt.clientId);
  if (!canEmail(client)) return false;
  try {
    const out = await callReminders({ action: 'confirm', appointmentId: appt.id });
    if (out.email) data.emails.push(toEmail(out.email));
    return !!out.sent;
  } catch (err) {
    toast('Booked, but the confirmation email failed: ' + err.message, true);
    return false;
  }
}
// The confirmation and reminder sent for a booking's current time
function apptEmails(appt) {
  const t = new Date(appt.start).getTime();
  const mine = data.emails.filter(e => e.apptId === appt.id && e.startsAt && new Date(e.startsAt).getTime() === t);
  return { confirmation: mine.find(e => e.kind === 'confirmation'), reminder: mine.find(e => e.kind === 'reminder') };
}
const EMAIL_KINDS = { confirmation: 'Booking confirmation', reminder: '24-hour reminder', nudge: 'Overdue reminder' };
const fmtWhen = iso => `${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

// ---------- Helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShort = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY_MS = 864e5;
const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

// "today", "yesterday", "5 days ago", "3 wks ago", "2 mo ago"
function ago(iso) {
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOf(new Date()) - startOf(new Date(iso))) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} wks ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${(days / 365).toFixed(1).replace('.0', '')} yr ago`;
}

// Line icons, drawn on a 24px grid
const ICONS = {
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.6 20 19M8.6 16.4 20 5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.4 3.5 5.2"/>',
  camera: '<path d="M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="m3.5 18 5.5-5.5 4 4 2.5-2.5 5 5"/>',
  left: '<path d="M15 5 8 12l7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
};
const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

let liveUrls = [];
function blobUrl(blob) { const u = URL.createObjectURL(blob); liveUrls.push(u); return u; }
function releaseUrls() { liveUrls.forEach(u => URL.revokeObjectURL(u)); liveUrls = []; }

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.innerHTML = (isError ? '' : icon('check')) + `<span>${esc(msg)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4000 : 2000);
}

function openViewer(src, caption) {
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `<button class="close" aria-label="Close">${icon('x')}</button><img src="${esc(src)}" alt=""><div class="cap">${esc(caption)}</div>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// Shrink a photo to a max size, as JPEG, so uploads are quick on cell data.
async function shrink(file, maxSide, quality) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', quality));
  } catch {
    return file;
  }
}

// Client stats from a list of their cuts
function clientStats(cuts) {
  const sorted = [...cuts].sort((a, b) => b.date.localeCompare(a.date));
  const timed = cuts.filter(c => c.minutes > 0).map(c => c.minutes);
  // Average days between visits, once there are at least two
  const gaps = [];
  for (let i = 0; i < sorted.length - 1; i++) gaps.push((new Date(sorted[i].date) - new Date(sorted[i + 1].date)) / DAY_MS);
  const every = gaps.length ? avg(gaps) : 0;
  const sinceLast = sorted[0] ? (Date.now() - new Date(sorted[0].date)) / DAY_MS : 0;
  return {
    count: cuts.length,
    total: cuts.reduce((s, c) => s + (c.price || 0), 0),
    avgPrice: avg(cuts.map(c => c.price || 0)),
    avgMinutes: avg(timed),
    last: sorted[0],
    first: sorted[sorted.length - 1],
    every,
    // Overdue once it's been noticeably longer than his usual gap
    due: every >= 7 && sinceLast > every * 1.25,
  };
}
function cutsByClient() {
  const by = {};
  for (const c of data.cuts) (by[c.clientId] ||= []).push(c);
  return by;
}
function latestPhotoByClient() {
  const cutDate = Object.fromEntries(data.cuts.map(c => [c.id, c.date]));
  const by = {};
  for (const p of data.photos) {
    const cur = by[p.clientId];
    if (!cur || (cutDate[p.cutId] || '') > (cutDate[cur.cutId] || '')) by[p.clientId] = p;
  }
  return by;
}
// Clients past their usual gap with nothing booked, most overdue first
function overdueClients() {
  const cutsBy = cutsByClient();
  const now = new Date();
  const booked = new Set(data.appts.filter(a => !a.cutId && apptEnd(a) > now).map(a => a.clientId));
  return data.clients.map(cl => ({ cl, s: clientStats(cutsBy[cl.id] || []) }))
    .filter(r => r.s.due && !booked.has(r.cl.id))
    .map(r => ({ ...r, late: Math.max(1, Math.round((now - new Date(r.s.last.date)) / DAY_MS - r.s.every)) }))
    .sort((a, b) => b.late / b.s.every - a.late / a.s.every);
}
const overdueBanner = n => n ? `<button class="banner" data-go="#overdue">${icon('alert')}<span><b>${plural(n, 'client')}</b> ${n === 1 ? 'is' : 'are'} overdue for a cut</span>${icon('right', 'chev')}</button>` : '';
const avatar = (client, photo) => `<div class="avatar">${photo ? `<img src="${esc(thumbUrl(photo))}" alt="" loading="lazy">` : esc(initials(client.name))}</div>`;
const fmtTime = d => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayKey = d => { d = new Date(d); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const startOfDay = d => { d = new Date(d); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const apptEnd = a => new Date(new Date(a.start).getTime() + a.minutes * 60000);
const everyText = days => days < 10 ? `${Math.round(days)} days` : `${Math.round(days / 7)} weeks`;

// ---------- Router ----------
const routes = [
  [/^#?(?:home)?$/, renderHome],
  [/^#clients$/, renderClients],
  [/^#client-([\w-]+)$/, renderClient],
  [/^#log(?:-([\w-]+))?$/, renderLog],
  [/^#schedule$/, renderSchedule],
  [/^#overdue$/, renderOverdue],
];
let clientBack = '#clients'; // where the back button on a client profile goes
let lastHash = '';
function route() {
  releaseUrls();
  closeSheet();
  if (!user) return;
  const hash = location.hash || '#home';
  if (hash.startsWith('#client-') && ['#schedule', '#clients', '#overdue'].includes(lastHash)) clientBack = lastHash;
  lastHash = hash;
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) { fn(...m.slice(1)); window.scrollTo(0, 0); return; }
  }
  location.hash = '#home';
}
window.addEventListener('hashchange', route);
const go = h => { location.hash = h; };

function topbar(title, fallback = '#home') {
  return `<div class="topbar"><button class="icon-btn" data-back="${fallback}" aria-label="Back">${icon('left')}</button><h1>${esc(title)}</h1></div>`;
}
function wireBack() {
  const b = $app.querySelector('[data-back]');
  if (b) b.onclick = () => go(b.dataset.back);
}

// ---------- Sign in ----------
function renderLogin() {
  $app.innerHTML = `
    <form class="login" id="login">
      <div class="wordmark">Cut<span>Folio</span></div>
      <div class="pole"></div>
      <input type="email" id="email" autocomplete="username" value="${esc(CONFIG.loginEmail || '')}" hidden>
      <input class="field" id="password" type="password" placeholder="Password" autocomplete="current-password" enterkeyhint="go" required>
      <button class="btn btn-red" id="signin">Unlock</button>
      <div class="error" id="loginError"></div>
    </form>`;
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signin');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    // The barber only types a password; the account email comes from config.js
    const { error } = await sb.auth.signInWithPassword({
      email: CONFIG.loginEmail,
      password: document.getElementById('password').value,
    });
    if (error) {
      document.getElementById('loginError').textContent = error.message === 'Invalid login credentials' ? 'Wrong password.' : error.message;
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  };
}

async function start(session) {
  if (!session) { user = null; renderLogin(); return; }
  if (user && user.id === session.user.id) return; // token refresh, nothing to reload
  user = session.user;
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    await loadData();
  } catch (err) {
    $app.innerHTML = `<div class="loading"><div>Couldn’t load your data.<br>${esc(err.message)}<br><button class="linkbtn" onclick="location.reload()">Try again</button></div></div>`;
    return;
  }
  route();
}

// ---------- Home / dashboard ----------
let monthOffset = 0;
function renderHome() {
  const { clients, cuts } = data;
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const start = ref, end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  const prevStart = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  const inRange = (c, a, b) => { const d = new Date(c.date); return d >= a && d < b; };
  const isCurrent = monthOffset === 0;

  const monthCuts = cuts.filter(c => inRange(c, start, end));
  const revenue = monthCuts.reduce((s, c) => s + (c.price || 0), 0);
  // Compare against the same stretch of last month, so the 5th isn't judged against a whole month
  const daysIn = (end - start) / DAY_MS | 0;
  const prevCutoff = isCurrent ? new Date(prevStart.getFullYear(), prevStart.getMonth(), now.getDate() + 1) : start;
  const prevRevenue = cuts.filter(c => inRange(c, prevStart, prevCutoff < start ? prevCutoff : start)).reduce((s, c) => s + (c.price || 0), 0);

  // First visit per client decides new vs returning
  const firstVisit = {};
  for (const c of cuts) if (!firstVisit[c.clientId] || c.date < firstVisit[c.clientId]) firstVisit[c.clientId] = c.date;
  const monthClients = [...new Set(monthCuts.map(c => c.clientId))];
  const newCount = monthClients.filter(id => inRange({ date: firstVisit[id] }, start, end)).length;
  const retCount = monthClients.length - newCount;

  // Revenue by day of month and by weekday
  const byDay = Array(daysIn).fill(0);
  const byWeekday = Array(7).fill(0);
  for (const c of monthCuts) {
    const d = new Date(c.date);
    byDay[d.getDate() - 1] += c.price || 0;
    byWeekday[d.getDay()] += c.price || 0;
  }
  const maxDay = Math.max(...byDay);
  const maxW = Math.max(...byWeekday);
  const bestW = maxW > 0 ? byWeekday.indexOf(maxW) : -1;
  const weekdayCount = Array(7).fill(0); // how many of each weekday he worked, for a per-day average
  const worked = new Set(monthCuts.map(c => new Date(c.date).toDateString()));
  worked.forEach(ds => weekdayCount[new Date(ds).getDay()]++);

  let delta = '';
  if (prevRevenue > 0) {
    const pct = Math.round(((revenue - prevRevenue) / prevRevenue) * 100);
    delta = `<span class="delta ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%</span><span>vs ${isCurrent ? 'this point last month' : 'the month before'}</span>`;
  } else {
    delta = `<span>${plural(monthCuts.length, 'cut')}</span>`;
  }
  const monthName = ref.toLocaleDateString('en-US', { month: 'long' });
  const order = [1, 2, 3, 4, 5, 6, 0];
  const today = now.getDate();

  $app.innerHTML = `
    <header class="masthead">
      <div class="row1">
        <div class="wordmark">Cut<span>Folio</span></div>
        <div class="today">${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      </div>
      <div class="pole"></div>
    </header>

    <div class="actions">
      <button class="btn btn-red btn-big" data-go="#log">${icon('scissors')}Log a cut</button>
      <button class="btn btn-tile" data-go="#clients">${icon('users')}Client portfolio</button>
      <button class="btn btn-tile" data-go="#schedule">${icon('calendar')}View schedule${nextUpLine()}</button>
    </div>
    ${overdueBanner(overdueClients().length)}

    <div class="month">
      <h2>${monthName}<small>${ref.getFullYear()}</small></h2>
      <button class="icon-btn" id="prevM" aria-label="Previous month">${icon('left')}</button>
      <button class="icon-btn" id="nextM" aria-label="Next month" ${isCurrent ? 'disabled' : ''}>${icon('right')}</button>
    </div>

    <section class="card hero">
      <div class="eyebrow">Revenue</div>
      <div class="num figure">${money(revenue)}</div>
      <div class="meta">${delta}</div>
      <div class="daybars" aria-hidden="true">${byDay.map((v, i) => {
        const future = isCurrent && i + 1 > today;
        const cls = isCurrent && i + 1 === today ? 'today' : v ? 'has' : future ? 'future' : '';
        return `<i class="${cls}" style="height:${maxDay ? Math.max(3, (v / maxDay) * 100) : 3}%"></i>`;
      }).join('')}</div>
      <div class="dayaxis"><span>1</span><span>${Math.ceil(daysIn / 2)}</span><span>${daysIn}</span></div>
    </section>

    <div class="pair">
      <section class="card stat">
        <div class="eyebrow">Customers</div>
        <div class="num figure">${clients.length}</div>
        <div class="sub">${monthClients.length} came in ${isCurrent ? 'this month' : 'in ' + monthName}</div>
      </section>
      <section class="card stat">
        <div class="eyebrow">Cuts</div>
        <div class="num figure">${monthCuts.length}</div>
        <div class="sub">${monthCuts.length ? money(revenue / monthCuts.length) + ' avg ticket' : 'none yet'}</div>
      </section>
    </div>

    <section class="card">
      <div class="eyebrow">New vs returning</div>
      <div class="split">${monthClients.length
        ? `${newCount ? `<div class="a" style="flex:${newCount}"></div>` : ''}${retCount ? `<div class="b" style="flex:${retCount}"></div>` : ''}`
        : ''}</div>
      <div class="split-legend">
        <div><span class="num figure">${newCount}</span><span class="k"><i class="swatch" style="background:var(--accent)"></i>New</span></div>
        <div><span class="num figure">${retCount}</span><span class="k">Returning<i class="swatch" style="background:var(--alt)"></i></span></div>
      </div>
    </section>

    <section class="card">
      <div class="eyebrow">Best day</div>
      <div class="num best-day">${bestW >= 0 ? DAYS[bestW] : '—'}</div>
      <div class="sub muted" style="font-size:14px;margin-top:6px">${bestW >= 0
        ? `${money(maxW)} across ${plural(weekdayCount[bestW], DAYS[bestW])}, about ${money(maxW / Math.max(1, weekdayCount[bestW]))} a day`
        : 'Log a few cuts to see which day earns most.'}</div>
      <div class="weekbars" aria-hidden="true">${order.map(i => `<div><i class="${i === bestW ? 'best' : ''}" style="height:${maxW ? Math.max(4, (byWeekday[i] / maxW) * 100) : 4}%"></i><span class="${i === bestW ? 'best' : ''}">${DAYS[i].slice(0, 2)}</span></div>`).join('')}</div>
    </section>

    ${cuts.length === 0 ? `<p class="hint">Tap <b>Log a cut</b> to add your first client.</p>` : ''}
    <button class="signout" id="signout">Sign out</button>
  `;
  $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  document.getElementById('prevM').onclick = () => { monthOffset--; renderHome(); };
  document.getElementById('nextM').onclick = () => { if (monthOffset < 0) { monthOffset++; renderHome(); } };
  const so = document.getElementById('signout');
  so.onclick = async () => {
    if (!so.dataset.armed) { so.dataset.armed = '1'; so.textContent = 'Tap again to sign out (needs the password to reopen)'; return; }
    await sb.auth.signOut();
  };
}

// ---------- Client portfolio ----------
function renderClients() {
  const cutsBy = cutsByClient();
  const photoBy = latestPhotoByClient();
  const rows = data.clients.map(cl => ({ cl, s: clientStats(cutsBy[cl.id] || []) }))
    .sort((a, b) => (b.s.last?.date || b.cl.createdAt).localeCompare(a.s.last?.date || a.cl.createdAt));

  $app.innerHTML = `
    ${topbar('Clients')}
    ${overdueBanner(overdueClients().length)}
    <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search by name or style" autocomplete="off" autocorrect="off"></label>
    <div class="count-line" id="count"></div>
    <div id="list"></div>
  `;
  wireBack();
  $app.querySelectorAll('.banner').forEach(b => b.onclick = () => go(b.dataset.go));
  const list = document.getElementById('list'), count = document.getElementById('count');
  const draw = (q) => {
    const nq = norm(q);
    const hits = rows.filter(r => !nq || norm(r.cl.name).includes(nq) || norm(r.s.last?.style || '').includes(nq));
    count.textContent = rows.length ? (nq ? `${hits.length} of ${plural(rows.length, 'client')}` : `${plural(rows.length, 'client')}, most recent first`) : '';
    if (!rows.length) list.innerHTML = `<div class="group empty">No clients yet.<br><button class="linkbtn" data-go="#log">Log your first cut</button></div>`;
    else if (!hits.length) list.innerHTML = `<div class="group empty">No one matches “${esc(q)}”.</div>`;
    else list.innerHTML = `<div class="group">${hits.map(({ cl, s }) => `
      <button class="row" data-id="${cl.id}">
        ${avatar(cl, photoBy[cl.id])}
        <div class="main">
          <div class="name">${esc(cl.name)}</div>
          <div class="meta">${s.last ? `${plural(s.count, 'cut')} · ${ago(s.last.date)}` : 'No cuts yet'}</div>
        </div>
        ${s.due ? '<span class="pill due">Due</span>' : ''}
        <div class="right">${s.count ? `<div class="num">${money(s.avgPrice)}</div><div class="meta">avg</div>` : ''}</div>
      </button>`).join('')}</div>`;
    list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => go('#client-' + b.dataset.id));
    list.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  };
  const q = document.getElementById('q');
  q.oninput = () => draw(q.value);
  draw('');
}

// ---------- Client profile ----------
function renderClient(id) {
  const client = data.clients.find(c => c.id === id);
  if (!client) return go('#clients');
  const cuts = data.cuts.filter(c => c.clientId === id);
  const cutById = Object.fromEntries(cuts.map(c => [c.id, c]));
  const mine = data.photos.filter(p => p.clientId === id)
    .sort((a, b) => (cutById[b.cutId]?.date || '').localeCompare(cutById[a.cutId]?.date || ''));
  const s = clientStats(cuts);
  const history = [...cuts].sort((a, b) => b.date.localeCompare(a.date));
  const first = client.name.split(' ')[0];
  const upcoming = data.appts.filter(a => a.clientId === id && !a.cutId && apptEnd(a) > new Date()).sort((a, b) => a.start.localeCompare(b.start))[0];
  const nextBooking = upcoming ? `${dayLabel(upcoming.start)}, ${fmtTime(upcoming.start)}` : '';

  $app.innerHTML = `
    ${topbar('', clientBack)}
    <div class="profile">
      ${avatar(client, mine[0])}
      <div style="min-width:0">
        <h2>${esc(client.name)}</h2>
        <div class="meta">${s.first ? 'Client since ' + fmtDate(s.first.date) : 'No cuts yet'}</div>
        <button class="linkbtn" id="rename">Edit name</button>
        <form id="renameForm" class="rename" hidden><input class="field" id="renameInput" autocapitalize="words"><button class="chip on" type="submit">Save</button></form>
      </div>
    </div>

    <section class="card statgrid">
      <div><div class="eyebrow">Avg price</div><div class="num figure">${s.count ? money(s.avgPrice) : '—'}</div></div>
      <div><div class="eyebrow">Avg time</div><div class="num figure">${s.avgMinutes ? Math.round(s.avgMinutes) + '<small style="font-size:18px"> min</small>' : '—'}</div></div>
      <div><div class="eyebrow">Cuts</div><div class="num figure">${s.count}</div></div>
      <div><div class="eyebrow">Total spent</div><div class="num figure">${money(s.total)}</div></div>
    </section>
    ${nextBooking ? `<div class="rhythm">${icon('calendar')}<span>Booked <b>${nextBooking}</b></span></div>` : ''}
    ${s.every ? `<div class="rhythm">${s.due ? '<span class="pill due">Due</span>' : ''}<span>Comes in about every <b>${everyText(s.every)}</b>. Last cut ${ago(s.last.date)}.</span></div>` : ''}

    <button class="btn btn-red" id="logFor">${icon('scissors')}Log a cut for ${esc(first)}</button>
    ${emailCard(client, upcoming)}

    <div class="section"><h3>Cuts</h3><span class="muted" style="font-size:13px">${mine.length ? plural(mine.length, 'photo') : ''}</span></div>
    ${mine.length ? `<div class="gallery">${mine.map(p => `<button data-photo="${p.id}"><img src="${esc(thumbUrl(p))}" alt="" loading="lazy"><span class="date">${cutById[p.cutId] ? fmtShort(cutById[p.cutId].date) : ''}</span></button>`).join('')}</div>`
      : `<div class="group empty">No photos yet. Add one next time you log a cut.</div>`}

    <div class="section"><h3>History</h3><span class="muted" style="font-size:13px">${history.length ? money(s.total) + ' total' : ''}</span></div>
    ${history.length ? `<div class="group ledger">${history.map(c => {
      const d = new Date(c.date);
      return `<div class="row">
        <div class="when"><div class="d">${d.getDate()}</div><div class="m">${d.toLocaleDateString('en-US', { month: 'short' })}${d.getFullYear() !== new Date().getFullYear() ? ' ’' + String(d.getFullYear()).slice(2) : ''}</div></div>
        <div class="main">
          <div class="name">${esc(c.style) || 'Haircut'}</div>
          <div class="meta">${[c.minutes ? c.minutes + ' min' : '', c.notes].filter(Boolean).map(esc).join(' · ') || DAYS[d.getDay()]}</div>
        </div>
        <div class="right"><div class="num">${money(c.price || 0)}</div><button class="del" data-del="${c.id}">Delete</button></div>
      </div>`;
    }).join('')}</div>` : `<div class="group empty">No cuts logged yet.</div>`}

    <div class="danger">
      <button class="btn btn-danger" id="removeClient">Remove ${esc(first)} from portfolio</button>
      <div class="note" id="removeNote" hidden>This deletes ${esc(first)}, ${plural(s.count, 'cut')}, and ${plural(mine.length, 'photo')} for good. Tap again to confirm.</div>
    </div>
  `;
  wireBack();
  document.getElementById('logFor').onclick = () => go('#log-' + id);
  $app.querySelectorAll('[data-photo]').forEach(b => {
    b.onclick = () => {
      const p = mine.find(x => x.id === b.dataset.photo);
      const c = cutById[p.cutId];
      openViewer(fullUrl(p), [c && fmtDate(c.date), c?.style, c && money(c.price || 0)].filter(Boolean).join(' · '));
    };
  });

  wireEmailCard(client);

  const renameForm = document.getElementById('renameForm'), renameInput = document.getElementById('renameInput');
  document.getElementById('rename').onclick = () => {
    renameForm.hidden = false; document.getElementById('rename').hidden = true;
    renameInput.value = client.name; renameInput.focus();
  };
  renameForm.onsubmit = async (e) => {
    e.preventDefault();
    const name = renameInput.value.trim();
    if (name && name !== client.name) {
      const { error } = await sb.from('clients').update({ name }).eq('id', id);
      if (error) return toast('Couldn’t rename: ' + error.message, true);
      client.name = name;
    }
    renderClient(id);
  };

  // Two taps to delete, so a stray tap can't wipe a cut
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap to confirm'; b.classList.add('armed'); return; }
    const cutId = b.dataset.del;
    b.disabled = true;
    const ph = data.photos.filter(p => p.cutId === cutId);
    const { error } = await sb.from('cuts').delete().eq('id', cutId); // photo rows go with it
    if (error) { b.disabled = false; return toast('Couldn’t delete: ' + error.message, true); }
    await removeFiles(ph);
    data.cuts = data.cuts.filter(c => c.id !== cutId);
    data.photos = data.photos.filter(p => p.cutId !== cutId);
    data.appts.forEach(a => { if (a.cutId === cutId) a.cutId = null; });
    renderClient(id);
  });

  const rm = document.getElementById('removeClient');
  rm.onclick = async () => {
    if (!rm.dataset.armed) {
      rm.dataset.armed = '1'; rm.classList.add('armed'); rm.textContent = `Yes, remove ${first}`;
      document.getElementById('removeNote').hidden = false;
      return;
    }
    rm.disabled = true; rm.textContent = 'Removing…';
    const { error } = await sb.from('clients').delete().eq('id', id); // cuts and photo rows go with it
    if (error) { rm.disabled = false; rm.textContent = `Yes, remove ${first}`; return toast('Couldn’t remove: ' + error.message, true); }
    await removeFiles(mine);
    data.clients = data.clients.filter(c => c.id !== id);
    data.cuts = data.cuts.filter(c => c.clientId !== id);
    data.photos = data.photos.filter(p => p.clientId !== id);
    data.appts = data.appts.filter(a => a.clientId !== id);
    toast(`Removed ${client.name}`);
    go('#clients');
  };
}
// Email sign-up and what's been sent, on the client profile
function emailCard(client, upcoming) {
  if (!emailReady) return '';
  const first = esc(client.name.split(' ')[0]);
  const form = `<form id="emailForm" class="rename" ${client.email ? 'hidden' : ''}>
      <input class="field" id="emailInput" type="email" inputmode="email" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="name@example.com" value="${esc(client.email)}">
      <button class="chip on" type="submit">Save</button></form>`;
  if (!client.email) return `
    <section class="card mail">
      <div class="eyebrow">Email reminders</div>
      <p class="sub">Add ${first}’s email to send a confirmation when you book and a reminder the day before.</p>
      ${form}
    </section>`;

  let status = '';
  if (upcoming) {
    const { confirmation, reminder } = apptEmails(upcoming);
    const remindAt = new Date(new Date(upcoming.start).getTime() - DAY_MS);
    const line = (ok, text) => `<div class="${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'clock')}<span>${text}</span></div>`;
    const remText = reminder ? `24-hour reminder sent ${fmtWhen(reminder.sentAt)}`
      : !client.reminders ? 'No reminder, unsubscribed'
      : confirmation && new Date(confirmation.sentAt) > remindAt ? 'No reminder needed, booked less than a day ahead'
      : `24-hour reminder goes out ${remindAt > new Date() ? fmtWhen(remindAt) : 'within 15 minutes'}`;
    status = `<div class="mail-status">
      <div class="eyebrow">${esc(dayLabel(upcoming.start))}, ${fmtTime(upcoming.start)} booking</div>
      ${line(confirmation, confirmation ? `Confirmation sent ${fmtWhen(confirmation.sentAt)}` : 'No confirmation sent for this time')}
      ${line(reminder, remText)}
    </div>`;
  }
  const sent = data.emails.filter(e => e.clientId === client.id).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return `
    <section class="card mail">
      <div class="mail-head"><div class="eyebrow">Email reminders</div>${client.reminders ? `<span class="pill ret">On</span>` : `<span class="pill due">Unsubscribed</span>`}</div>
      <div class="mail-addr" id="emailShow">${icon('mail')}<span>${esc(client.email)}</span><button class="linkbtn" id="editEmail">Edit</button></div>
      ${form}
      ${status}
      ${sent.length ? `<div class="mail-log">${sent.slice(0, 4).map(e => `<div><span>${EMAIL_KINDS[e.kind]}</span><span class="muted">${fmtWhen(e.sentAt)}</span></div>`).join('')}</div>`
        : `<p class="sub">No emails sent yet.</p>`}
      ${client.reminders ? '' : `<button class="linkbtn" id="resub">Turn reminders back on (only if ${first} asked)</button>`}
      ${CONFIG.remindersUrl ? '' : `<p class="sub">Emails start sending once AWS is connected.</p>`}
    </section>`;
}
function wireEmailCard(client) {
  const form = document.getElementById('emailForm');
  if (!form) return;
  const save = async (fields, done) => {
    const { error } = await sb.from('clients').update(fields).eq('id', client.id);
    if (error) return toast('Couldn’t save: ' + error.message, true);
    Object.assign(client, fields);
    if (done) toast(done);
    renderClient(client.id);
  };
  const edit = document.getElementById('editEmail');
  if (edit) edit.onclick = () => { form.hidden = false; document.getElementById('emailShow').hidden = true; document.getElementById('emailInput').focus(); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const email = document.getElementById('emailInput').value.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('That email doesn’t look right', true);
    if (email === client.email) return renderClient(client.id);
    save({ email }, email ? (client.email ? 'Email updated' : 'Reminders on') : 'Email removed');
  };
  const resub = document.getElementById('resub');
  if (resub) resub.onclick = () => save({ reminders: true }, 'Reminders back on');
}

async function removeFiles(photos) {
  const paths = photos.flatMap(p => [p.path, p.thumbPath]);
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
}

// ---------- Log cut ----------
const PRICE_CHIPS = [25, 30, 35, 40, 50];
const TIME_CHIPS = [20, 30, 45, 60];
let apptToLog = null; // set when "Log this cut" is tapped on a booking
function renderLog(presetId) {
  const { clients } = data;
  const appt = apptToLog && apptToLog.clientId === presetId ? apptToLog : null;
  apptToLog = null;
  const cutsBy = cutsByClient();
  const photoBy = latestPhotoByClient();

  const state = {
    mode: clients.length ? 'returning' : 'new',
    client: presetId ? clients.find(c => c.id === presetId) || null : null,
    files: [],      // { full, thumb, url }
    price: '',
    minutes: '',
    style: '',
    notes: '',
    date: toLocalInput(new Date()),
  };
  if (state.client) { state.mode = 'returning'; applyClientDefaults(); }
  if (appt && !state.minutes) state.minutes = String(appt.minutes);

  function applyClientDefaults() {
    const s = clientStats(cutsBy[state.client.id] || []);
    if (s.last) {
      state.price = String(s.last.price ?? '');
      state.minutes = s.avgMinutes ? String(Math.round(s.avgMinutes / 5) * 5) : '';
      state.style = s.last.style || '';
    }
  }

  $app.innerHTML = `
    ${topbar('Log a cut', appt ? '#schedule' : presetId ? '#client-' + presetId : '#home')}
    <div class="seg" id="seg">
      <button data-mode="returning">Returning</button>
      <button data-mode="new">New client</button>
    </div>
    <div class="block">
      <label class="label" for="name">Client</label>
      <input class="field" id="name" placeholder="Start typing a name…" autocomplete="off" autocorrect="off" autocapitalize="words" enterkeyhint="done">
      <div id="suggest"></div>
      <div class="status" id="status"></div>
    </div>

    <div class="block">
      <span class="label">Photos</span>
      <div class="photo-btns">
        <button class="photo-btn primary" id="takePhoto">${icon('camera')}Take photo</button>
        <button class="photo-btn" id="uploadPhoto">${icon('image')}From library</button>
      </div>
      <div class="thumbs" id="thumbs"></div>
    </div>

    <div class="block">
      <label class="label" for="price">Price</label>
      <div class="money"><span>$</span><input class="field" id="price" inputmode="decimal" placeholder="0" enterkeyhint="done"></div>
      <div class="chips" id="priceChips">${PRICE_CHIPS.map(p => `<button class="chip" data-v="${p}">$${p}</button>`).join('')}</div>
    </div>

    <div class="block">
      <span class="label">Time in the chair</span>
      <div class="chips" id="timeChips">${TIME_CHIPS.map(m => `<button class="chip" data-v="${m}">${m} min</button>`).join('')}
        <input class="field chip-input" id="minutes" inputmode="numeric" placeholder="Other" aria-label="Other minutes"></div>
    </div>

    <details class="more" id="more">
      <summary>${icon('plus')}Style, notes, date</summary>
      <div class="more-body">
        <label class="label" for="style">Style</label>
        <input class="field" id="style" placeholder="e.g. Low fade, #2 on the sides" autocapitalize="sentences">
        <label class="label" for="notes">Notes</label>
        <textarea class="field" id="notes" placeholder="Anything to remember next time"></textarea>
        <label class="label" for="date">Date and time</label>
        <input class="field" id="date" type="datetime-local">
      </div>
    </details>

    <div class="savebar"><button class="btn btn-red" id="save">Save cut</button></div>
  `;
  wireBack();

  const $ = id => document.getElementById(id);
  const nameEl = $('name'), sugEl = $('suggest'), statusEl = $('status');

  function drawMode() {
    $('seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
    nameEl.placeholder = state.mode === 'returning' ? 'Start typing a name…' : 'New client’s name';
  }
  function drawStatus() {
    const typed = nameEl.value.trim();
    if (!state.client && sugEl.childElementCount) { statusEl.innerHTML = ''; return; }
    if (state.client) {
      const s = clientStats(cutsBy[state.client.id] || []);
      statusEl.innerHTML = `<span class="pill ret">${icon('check')}Returning · ${plural(s.count, 'cut')}${s.last ? ', last ' + ago(s.last.date) : ''}</span>`;
    } else if (typed) {
      const dup = clients.find(c => norm(c.name) === norm(typed));
      statusEl.innerHTML = dup
        ? `<button class="pill ret">${esc(dup.name)} is already a client · tap to use</button>`
        : `<span class="pill new">${icon('plus')}New client</span>`;
      if (dup) statusEl.firstChild.onclick = () => pick(dup);
    } else statusEl.innerHTML = '';
    statusEl.querySelectorAll('.ico').forEach(i => { i.style.width = '14px'; i.style.height = '14px'; i.style.strokeWidth = '2.6'; });
  }
  function drawSuggest() {
    const q = norm(nameEl.value);
    if (state.mode !== 'returning' || state.client || !q) { sugEl.innerHTML = ''; return; }
    const hits = clients
      .filter(c => norm(c.name).includes(q))
      .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 5);
    sugEl.innerHTML = hits.length ? `<div class="group suggest">${hits.map(c => {
      const s = clientStats(cutsBy[c.id] || []);
      return `<button class="row" data-id="${c.id}">${avatar(c, photoBy[c.id])}<div class="main"><div class="name">${esc(c.name)}</div><div class="meta">${s.last ? 'last cut ' + ago(s.last.date) : 'no cuts yet'}</div></div>${s.last ? `<div class="right"><div class="num" style="font-size:20px">${money(s.last.price)}</div></div>` : ''}</button>`;
    }).join('')}</div>` : '';
    sugEl.querySelectorAll('[data-id]').forEach(b => {
      // pointerdown so the tap lands before the keyboard closes
      b.addEventListener('pointerdown', e => { e.preventDefault(); pick(clients.find(c => c.id === b.dataset.id)); });
    });
  }
  function pick(c) {
    state.client = c; state.mode = 'returning';
    nameEl.value = c.name;
    applyClientDefaults();
    sugEl.innerHTML = '';
    nameEl.blur();
    drawMode(); drawStatus(); drawPrice(); drawTime(); $('style').value = state.style;
  }
  nameEl.oninput = () => {
    if (state.client && nameEl.value !== state.client.name) state.client = null;
    drawSuggest(); drawStatus();
  };
  $('seg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.mode = b.dataset.mode;
    if (state.mode === 'new') state.client = null;
    drawMode(); drawSuggest(); drawStatus();
    nameEl.focus();
  });

  // Photos: shrink right away so Save only has to upload
  const cam = document.getElementById('camInput'), lib = document.getElementById('libInput');
  $('takePhoto').onclick = () => cam.click();
  $('uploadPhoto').onclick = () => lib.click();
  let pending = Promise.resolve();
  const onFiles = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    pending = pending.then(async () => {
      for (const f of files) {
        const [full, thumb] = await Promise.all([shrink(f, 1600, 0.82), shrink(f, 480, 0.75)]);
        state.files.push({ full, thumb, url: blobUrl(thumb) });
        drawThumbs();
      }
    });
  };
  cam.onchange = onFiles; lib.onchange = onFiles;
  function drawThumbs() {
    $('thumbs').innerHTML = state.files.map((f, i) => `<div class="thumb"><img src="${f.url}" alt=""><button data-i="${i}" aria-label="Remove photo">${icon('x')}</button></div>`).join('');
    $('thumbs').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { state.files.splice(+b.dataset.i, 1); drawThumbs(); });
  }

  // Price + time
  function drawPrice() {
    $('price').value = state.price;
    $('priceChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === state.price));
  }
  function drawTime() {
    const isChip = TIME_CHIPS.map(String).includes(state.minutes);
    $('minutes').value = isChip ? '' : state.minutes;
    $('timeChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === state.minutes));
  }
  $('price').oninput = e => { state.price = e.target.value.replace(/[^\d.]/g, ''); drawPrice(); };
  $('priceChips').querySelectorAll('.chip').forEach(c => c.onclick = () => { state.price = c.dataset.v; drawPrice(); });
  $('minutes').oninput = e => { state.minutes = e.target.value.replace(/\D/g, ''); $('timeChips').querySelectorAll('.chip').forEach(c => c.classList.remove('on')); };
  $('timeChips').querySelectorAll('.chip').forEach(c => c.onclick = () => { state.minutes = state.minutes === c.dataset.v ? '' : c.dataset.v; drawTime(); });
  $('style').oninput = e => state.style = e.target.value;
  $('notes').oninput = e => state.notes = e.target.value;
  $('date').value = state.date;
  $('date').oninput = e => state.date = e.target.value;

  if (state.client) nameEl.value = state.client.name;
  drawMode(); drawStatus(); drawPrice(); drawTime(); $('style').value = state.style;

  $('save').onclick = async () => {
    const typed = nameEl.value.trim();
    if (!state.client && !typed) { nameEl.focus(); toast('Add a client name', true); return; }
    const price = parseFloat(state.price);
    if (!(price >= 0)) { $('price').focus(); toast('Add a price', true); return; }
    const btn = $('save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await pending; // photos still being shrunk
      let client = state.client || clients.find(c => norm(c.name) === norm(typed));
      const isNew = !client;
      if (isNew) client = { id: uuid(), name: typed, createdAt: new Date().toISOString() };
      const d = state.date ? new Date(state.date) : new Date();
      const cut = {
        id: uuid(), clientId: client.id, date: (isNaN(d) ? new Date() : d).toISOString(),
        price, minutes: parseInt(state.minutes, 10) || 0,
        style: state.style.trim(), notes: state.notes.trim(),
      };

      // Upload photos first, so a failed upload doesn't leave a half-saved cut
      const photos = [];
      for (let i = 0; i < state.files.length; i++) {
        btn.textContent = state.files.length > 1 ? `Uploading photo ${i + 1} of ${state.files.length}…` : 'Uploading photo…';
        const f = state.files[i];
        const pid = uuid();
        const base = `${user.id}/${client.id}/${cut.id}/${pid}`;
        const opts = { contentType: 'image/jpeg', cacheControl: '31536000' };
        const [a, b] = await Promise.all([
          sb.storage.from(BUCKET).upload(base + '.jpg', f.full, opts),
          sb.storage.from(BUCKET).upload(base + '-thumb.jpg', f.thumb, opts),
        ]);
        if (a.error || b.error) throw (a.error || b.error);
        photos.push({ id: pid, cutId: cut.id, clientId: client.id, path: base + '.jpg', thumbPath: base + '-thumb.jpg' });
      }

      btn.textContent = 'Saving…';
      if (isNew) {
        const { error } = await sb.from('clients').insert({ id: client.id, name: client.name });
        if (error) throw error;
        data.clients.push(client);
        state.client = client; // a retry after a failure below must not add the client twice
      }
      const { error: cutErr } = await sb.from('cuts').insert({
        id: cut.id, client_id: cut.clientId, date: cut.date, price: cut.price,
        minutes: cut.minutes, style: cut.style, notes: cut.notes,
      });
      if (cutErr) throw cutErr;
      if (appt) {
        // Mark the booking as done; the cut is saved either way
        const { error } = await sb.from('appointments').update({ cut_id: cut.id }).eq('id', appt.id);
        if (!error) appt.cutId = cut.id;
      }
      if (photos.length) {
        const { error } = await sb.from('photos').insert(photos.map(p => ({ id: p.id, cut_id: p.cutId, client_id: p.clientId, path: p.path, thumb_path: p.thumbPath })));
        if (error) throw error;
      }

      // Show the new photos straight from the phone's copy, no need to download them again
      state.files.forEach((f, i) => {
        photoUrls[photos[i].thumbPath] = URL.createObjectURL(f.thumb);
        photoUrls[photos[i].path] = URL.createObjectURL(f.full);
      });
      data.cuts.push(cut);
      data.photos.push(...photos);
      toast(`Saved ${money(price)} cut for ${client.name.split(' ')[0]}`);
      go(appt ? '#schedule' : '#home');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save cut';
      toast('Couldn’t save: ' + (err.message || err) + '. Check your connection and try again.', true);
    }
  };

  if (!state.client) setTimeout(() => nameEl.focus(), 50);
}
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- Schedule ----------
const DAY_OPEN = 9 * 60;            // first slot offered on an empty day, in minutes after midnight
const LEN_CHIPS = [15, 30, 45, 60];
let schedDay = startOfDay(new Date());

function dayLabel(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
const apptsOn = day => data.appts.filter(a => dayKey(a.start) === dayKey(day)).sort((a, b) => a.start.localeCompare(b.start));

// Projected length and price for a client, from their past cuts. New clients
// get the shop-wide average length.
function projection(clientId) {
  const s = clientId ? clientStats(data.cuts.filter(c => c.clientId === clientId)) : null;
  const shopAvg = avg(data.cuts.filter(c => c.minutes > 0).map(c => c.minutes));
  const fromClient = s && s.avgMinutes;
  const minutes = Math.max(5, Math.round((fromClient || shopAvg || 30) / 5) * 5);
  return { minutes, price: s && s.count ? s.avgPrice : 0, basis: fromClient ? 'client' : shopAvg ? 'shop' : 'default', count: s ? s.count : 0 };
}

// Earliest start on `day` with room for `len` minutes, at or after `from` (minutes after midnight)
function nextOpen(day, len, from) {
  const base = startOfDay(day).getTime();
  let t = from ?? DAY_OPEN;
  if (dayKey(day) === dayKey(new Date())) {
    const now = new Date();
    t = Math.max(t, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15);
  }
  for (const a of apptsOn(day)) {
    const aStart = (new Date(a.start) - base) / 60000, aEnd = aStart + a.minutes;
    if (aStart < t + len && aEnd > t) t = aEnd;
  }
  return t;
}

// "Next: Marcus 2:30 PM" under the home button
function nextUpLine() {
  if (!scheduleReady) return '';
  const now = new Date();
  const next = data.appts.filter(a => !a.cutId && apptEnd(a) > now && dayKey(a.start) === dayKey(now))
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!next) return '';
  const cl = data.clients.find(c => c.id === next.clientId);
  return `<small class="next-up">Next: ${esc(cl ? cl.name.split(' ')[0] : 'client')} ${fmtTime(next.start)}</small>`;
}

function renderSchedule() {
  if (!scheduleReady) {
    $app.innerHTML = `
      ${topbar('Schedule')}
      <div class="placeholder">${icon('calendar')}<h2>One setup step</h2><p>Open Supabase → SQL Editor, paste <b>supabase/schedule.sql</b>, press Run, then reopen CutFolio.</p></div>`;
    wireBack();
    return;
  }
  const today = startOfDay(new Date());
  const isToday = dayKey(schedDay) === dayKey(today);
  // Week strip, Monday first
  const monday = new Date(schedDay); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const counts = {};
  for (const a of data.appts) counts[dayKey(a.start)] = (counts[dayKey(a.start)] || 0) + 1;

  const list = apptsOn(schedDay);
  const clientBy = Object.fromEntries(data.clients.map(c => [c.id, c]));
  const photoBy = latestPhotoByClient();
  const projected = list.reduce((sum, a) => {
    if (a.cutId) return sum + (data.cuts.find(c => c.id === a.cutId)?.price || 0);
    return sum + projection(a.clientId).price;
  }, 0);
  const base = schedDay.getTime();

  let rows = '';
  list.forEach((a, i) => {
    const prev = list[i - 1];
    if (prev) {
      const gap = (new Date(a.start) - apptEnd(prev)) / 60000;
      if (gap >= 15) rows += `<button class="gap" data-at="${(apptEnd(prev) - base) / 60000}">${icon('plus')}Open ${fmtTime(apptEnd(prev))}, ${gap >= 60 ? (gap / 60).toFixed(1).replace('.0', '') + ' hr' : gap + ' min'}</button>`;
    }
    const cl = clientBy[a.clientId] || { name: 'Client', id: a.clientId };
    const p = projection(a.clientId);
    const cut = a.cutId && data.cuts.find(c => c.id === a.cutId);
    const t = fmtTime(a.start).split(' ');
    const sentNow = apptEmails(a);
    const mailTag = sentNow.reminder ? 'reminded' : sentNow.confirmation ? 'confirmed' : '';
    rows += `<button class="row appt${cut ? ' done' : ''}" data-appt="${a.id}">
      <div class="when"><div class="t">${t[0]}</div><div class="m">${t[1] || ''}</div></div>
      ${avatar(cl, photoBy[cl.id])}
      <div class="main">
        <div class="name">${esc(cl.name)}</div>
        <div class="meta">${a.minutes} min · until ${fmtTime(apptEnd(a))}${a.notes ? ' · ' + esc(a.notes) : ''}</div>
        ${mailTag ? `<div class="mail-tag">${icon('mail')}${mailTag}</div>` : ''}
      </div>
      <div class="right">${cut ? `<span class="pill ret">${icon('check')}${money(cut.price)}</span>` : p.price ? `<div class="num">${money(Math.round(p.price))}</div><div class="meta">usual</div>` : `<span class="pill new">New</span>`}</div>
    </button>`;
  });

  $app.innerHTML = `
    <div class="topbar"><button class="icon-btn" data-back="#home" aria-label="Back">${icon('left')}</button><h1>Schedule</h1>${isToday ? '' : `<button class="chip" id="toToday">Today</button>`}</div>
    <div class="week">
      <button class="icon-btn" id="prevW" aria-label="Previous week">${icon('left')}</button>
      <div class="days">${week.map(d => `<button data-day="${d.getTime()}" class="${dayKey(d) === dayKey(schedDay) ? 'on' : ''}${dayKey(d) === dayKey(today) ? ' today' : ''}">
        <span class="w">${DAYS[d.getDay()].slice(0, 2)}</span><span class="d">${d.getDate()}</span><span class="dots">${counts[dayKey(d)] ? (counts[dayKey(d)] > 9 ? '9+' : counts[dayKey(d)]) : ''}</span></button>`).join('')}</div>
      <button class="icon-btn" id="nextW" aria-label="Next week">${icon('right')}</button>
    </div>
    <section class="card dayhead">
      <div class="eyebrow">${['Today', 'Tomorrow', 'Yesterday'].includes(dayLabel(schedDay)) ? dayLabel(schedDay) : DAYS[schedDay.getDay()]}</div>
      <h2>${schedDay.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</h2>
      <div class="meta">${list.length
        ? `<span>${plural(list.length, 'client')}</span><span>${fmtTime(list[0].start)} – ${fmtTime(apptEnd(list[list.length - 1]))}</span>${projected ? `<span>~${money(Math.round(projected))}</span>` : ''}`
        : '<span>Nothing booked yet</span>'}</div>
    </section>
    ${list.length ? `<div class="group sched">${rows}</div>` : `<div class="group empty">Tap <b>Book a client</b> to fill this day.</div>`}
    <div class="savebar"><button class="btn btn-red" id="book">${icon('plus')}Book a client</button></div>
  `;
  wireBack();
  const $ = id => document.getElementById(id);
  const shiftWeek = n => { schedDay = new Date(schedDay.getFullYear(), schedDay.getMonth(), schedDay.getDate() + n * 7); renderSchedule(); };
  $('prevW').onclick = () => shiftWeek(-1);
  $('nextW').onclick = () => shiftWeek(1);
  if ($('toToday')) $('toToday').onclick = () => { schedDay = today; renderSchedule(); };
  $app.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { schedDay = new Date(+b.dataset.day); renderSchedule(); });
  $app.querySelectorAll('[data-appt]').forEach(b => b.onclick = () => openBooking({ appt: data.appts.find(a => a.id === b.dataset.appt) }));
  $app.querySelectorAll('[data-at]').forEach(b => b.onclick = () => openBooking({ at: +b.dataset.at }));
  $('book').onclick = () => openBooking({});
}

// "Confirmation sent · reminder goes out Fri 2:00 PM" on an open booking
function bookingMailLine(appt, client) {
  if (!emailReady || appt.cutId || apptEnd(appt) < new Date()) return '';
  if (!client?.email) return `<div class="mail-line muted">${icon('mail')}<span>No email on file for reminders</span></div>`;
  const { confirmation, reminder } = apptEmails(appt);
  const parts = [confirmation ? 'Confirmation sent' : 'No confirmation sent'];
  if (reminder) parts.push(`reminder sent ${fmtWhen(reminder.sentAt)}`);
  else {
    const remindAt = new Date(new Date(appt.start).getTime() - DAY_MS);
    if (client.reminders && !(confirmation && new Date(confirmation.sentAt) > remindAt)) parts.push(`reminder goes out ${remindAt > new Date() ? fmtWhen(remindAt) : 'within 15 min'}`);
  }
  if (!client.reminders) parts.push('unsubscribed');
  return `<div class="mail-line">${icon('mail')}<span>${parts.join(' · ')}</span></div>`;
}

function closeSheet() { document.querySelectorAll('.sheet-wrap').forEach(el => el.remove()); document.body.classList.remove('sheet-open'); }

// One sheet for booking a new client and for changing an existing booking.
// Booking keeps the sheet open and moves to the next open slot, so a whole day
// can be filled in one go.
function openBooking({ appt, at }) {
  closeSheet();
  const editing = !!appt;
  const state = {
    client: editing ? data.clients.find(c => c.id === appt.clientId) : null,
    day: editing ? startOfDay(appt.start) : schedDay,
    minutes: editing ? appt.minutes : projection(null).minutes,
    lenSet: editing, // true once he picks a length, so choosing a client doesn't overwrite it
    at: 0,
    notes: editing ? appt.notes : '',
    booked: [],
  };
  state.at = editing ? (new Date(appt.start) - startOfDay(appt.start)) / 60000 : nextOpen(state.day, state.minutes, at);

  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const first = state.client ? state.client.name.split(' ')[0] : '';
  wrap.innerHTML = `
    <div class="sheet-scrim"></div>
    <div class="sheet" role="dialog" aria-label="${editing ? 'Booking' : 'Book a client'}">
      <div class="sheet-head"><h2>${editing ? 'Booking' : 'Book a client'}</h2><button class="icon-btn" id="bClose" aria-label="Close">${icon('x')}</button></div>
      ${editing ? `
        <div class="who">
          ${avatar(state.client || { name: '?' }, latestPhotoByClient()[appt.clientId])}
          <div class="main"><div class="name">${esc(state.client?.name || 'Client')}</div><div class="meta" id="bWhoMeta"></div></div>
        </div>
        ${bookingMailLine(appt, state.client)}
        <div class="pair">
          <button class="btn" id="bProfile">${icon('users')}View profile</button>
          ${appt.cutId ? `<button class="btn" disabled>${icon('check')}Logged</button>` : `<button class="btn btn-red" id="bLog">${icon('scissors')}Log this cut</button>`}
        </div>`
      : `
        <div class="done-line" id="bDone" hidden></div>
        <div class="block">
          <label class="label" for="bName">Client</label>
          <input class="field" id="bName" placeholder="Name, new or returning" autocomplete="off" autocorrect="off" autocapitalize="words" enterkeyhint="done">
          <div id="bSuggest"></div>
          <div class="status" id="bStatus"></div>
        </div>`}
      <div class="block">
        <span class="label">When</span>
        <div class="when-row">
          <input class="field" id="bDate" type="date" aria-label="Day">
          <div class="stepper">
            <button class="icon-btn" id="bEarlier" aria-label="15 minutes earlier">${icon('minus')}</button>
            <input class="field" id="bTime" type="time" step="300" aria-label="Start time">
            <button class="icon-btn" id="bLater" aria-label="15 minutes later">${icon('plus')}</button>
          </div>
        </div>
      </div>
      <div class="block">
        <span class="label">Length (min)</span>
        <div class="chips" id="bLen">${LEN_CHIPS.map(m => `<button class="chip" data-v="${m}">${m}</button>`).join('')}<button class="chip" data-v="other" id="bLenOther"></button></div>
        <div class="projection" id="bProj"></div>
        <div class="warn" id="bWarn"></div>
      </div>
      <input class="field" id="bNotes" placeholder="Note (optional)" autocapitalize="sentences">
      <button class="btn btn-red" id="bSave">${editing ? 'Save changes' : 'Book'}</button>
      ${editing ? `<button class="btn btn-danger" id="bRemove">Remove booking</button>` : ''}
    </div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('sheet-open');
  const $ = id => wrap.querySelector('#' + id);
  const close = () => { wrap.remove(); document.body.classList.remove('sheet-open'); };
  wrap.querySelector('.sheet-scrim').onclick = close;
  $('bClose').onclick = close;
  const p2 = n => String(n).padStart(2, '0');
  const startDate = () => new Date(state.day.getFullYear(), state.day.getMonth(), state.day.getDate(), 0, state.at);

  function draw() {
    $('bDate').value = `${state.day.getFullYear()}-${p2(state.day.getMonth() + 1)}-${p2(state.day.getDate())}`;
    $('bTime').value = `${p2(Math.floor(state.at / 60) % 24)}:${p2(state.at % 60)}`;
    const other = !LEN_CHIPS.includes(state.minutes);
    $('bLen').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === String(state.minutes) || (other && c.dataset.v === 'other')));
    $('bLenOther').textContent = other ? `${state.minutes} min` : 'Other';
    const p = projection(state.client?.id);
    const end = new Date(startDate().getTime() + state.minutes * 60000);
    const why = p.basis === 'client' ? `${first || state.client.name.split(' ')[0]} averages ${p.minutes} min` : p.basis === 'shop' ? `Your average cut is ${p.minutes} min` : '';
    $('bProj').innerHTML = `${icon('clock')}<span>${fmtTime(startDate())} – <b>${fmtTime(end)}</b>${why ? ' · ' + why : ''}${p.price ? ` · usually ${money(Math.round(p.price))}` : ''}</span>`;
    // Overlap check against the rest of that day
    const s0 = startDate(), e0 = end;
    const clash = apptsOn(state.day).filter(a => (!editing || a.id !== appt.id) && new Date(a.start) < e0 && apptEnd(a) > s0);
    $('bWarn').textContent = clash.length ? `Overlaps ${clash.map(a => (data.clients.find(c => c.id === a.clientId)?.name.split(' ')[0] || 'a client') + ' at ' + fmtTime(a.start)).join(', ')}` : '';
    if (editing) {
      const st = clientStats(data.cuts.filter(c => c.clientId === appt.clientId));
      $('bWhoMeta').textContent = st.last ? `${plural(st.count, 'cut')} · last ${ago(st.last.date)}` : 'No cuts yet';
    }
  }

  $('bDate').onchange = e => {
    const [y, m, d] = e.target.value.split('-').map(Number);
    if (!y) return;
    state.day = new Date(y, m - 1, d);
    if (!editing) state.at = nextOpen(state.day, state.minutes);
    draw();
  };
  $('bTime').onchange = e => {
    const [h, m] = e.target.value.split(':').map(Number);
    if (h >= 0) state.at = h * 60 + (m || 0);
    draw();
  };
  $('bEarlier').onclick = () => { state.at = Math.max(0, Math.ceil(state.at / 15) * 15 - 15); draw(); };
  $('bLater').onclick = () => { state.at = Math.min(23 * 60 + 45, Math.floor(state.at / 15) * 15 + 15); draw(); };
  $('bLen').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    if (c.dataset.v === 'other') {
      const v = parseInt(prompt('Length in minutes', state.minutes), 10);
      if (v > 0 && v <= 600) state.minutes = v;
    } else state.minutes = +c.dataset.v;
    state.lenSet = true;
    draw();
  });
  $('bNotes').value = state.notes;
  $('bNotes').oninput = e => state.notes = e.target.value;

  if (!editing) {
    const nameEl = $('bName'), sugEl = $('bSuggest'), statusEl = $('bStatus');
    const photoBy = latestPhotoByClient();
    const pick = c => {
      state.client = c;
      nameEl.value = c.name;
      sugEl.innerHTML = '';
      if (!state.lenSet) state.minutes = projection(c.id).minutes;
      nameEl.blur();
      drawStatus(); draw();
    };
    function drawStatus() {
      const typed = nameEl.value.trim();
      if (state.client) {
        const st = clientStats(data.cuts.filter(c => c.clientId === state.client.id));
        statusEl.innerHTML = `<span class="pill ret">${icon('check')}${st.count ? `Returning · ${plural(st.count, 'cut')}` : 'In your portfolio'}</span>`;
      } else statusEl.innerHTML = typed && !sugEl.childElementCount ? `<span class="pill new">${icon('plus')}New client</span>` : '';
      statusEl.querySelectorAll('.ico').forEach(i => { i.style.width = '14px'; i.style.height = '14px'; i.style.strokeWidth = '2.6'; });
    }
    nameEl.oninput = () => {
      if (state.client && nameEl.value !== state.client.name) {
        state.client = null;
        if (!state.lenSet) state.minutes = projection(null).minutes;
        draw();
      }
      const q = norm(nameEl.value);
      const hits = q ? data.clients.filter(c => norm(c.name).includes(q))
        .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 4) : [];
      const exact = hits.length === 1 && norm(hits[0].name) === q;
      sugEl.innerHTML = hits.length && !exact ? `<div class="group suggest">${hits.map(c => {
        const p = projection(c.id);
        return `<button class="row" data-id="${c.id}">${avatar(c, photoBy[c.id])}<div class="main"><div class="name">${esc(c.name)}</div><div class="meta">${p.basis === 'client' ? p.minutes + ' min usually' : 'no timed cuts yet'}</div></div></button>`;
      }).join('')}</div>` : '';
      sugEl.querySelectorAll('[data-id]').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); pick(data.clients.find(c => c.id === b.dataset.id)); }));
      if (exact) pick(hits[0]); else drawStatus();
    };
    setTimeout(() => nameEl.focus(), 60);
  } else {
    $('bProfile').onclick = () => { close(); go('#client-' + appt.clientId); };
    if ($('bLog')) $('bLog').onclick = () => { apptToLog = appt; close(); go('#log-' + appt.clientId); };
    const rm = $('bRemove');
    rm.onclick = async () => {
      if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.classList.add('armed'); rm.textContent = 'Tap again to remove'; return; }
      rm.disabled = true;
      const { error } = await sb.from('appointments').delete().eq('id', appt.id);
      if (error) { rm.disabled = false; return toast('Couldn’t remove: ' + error.message, true); }
      data.appts = data.appts.filter(a => a.id !== appt.id);
      close(); renderSchedule();
    };
  }

  $('bSave').onclick = async () => {
    const btn = $('bSave');
    const starts = startDate().toISOString();
    if (editing) {
      btn.disabled = true; btn.textContent = 'Saving…';
      const { error } = await sb.from('appointments').update({ starts_at: starts, minutes: state.minutes, notes: state.notes.trim() }).eq('id', appt.id);
      if (error) { btn.disabled = false; btn.textContent = 'Save changes'; return toast('Couldn’t save: ' + error.message, true); }
      const moved = new Date(appt.start).getTime() !== new Date(starts).getTime();
      Object.assign(appt, { start: starts, minutes: state.minutes, notes: state.notes.trim() });
      schedDay = state.day;
      close(); renderSchedule();
      if (moved && await confirmBooking(appt)) { toast(`Emailed ${state.client.name.split(' ')[0]} the new time`); renderSchedule(); }
      return;
    }
    const nameEl = $('bName');
    const typed = nameEl.value.trim();
    if (!state.client && !typed) { nameEl.focus(); return toast('Add a client name', true); }
    btn.disabled = true; btn.textContent = 'Booking…';
    try {
      let client = state.client || data.clients.find(c => norm(c.name) === norm(typed));
      if (!client) {
        client = { id: uuid(), name: typed, createdAt: new Date().toISOString() };
        const { error } = await sb.from('clients').insert({ id: client.id, name: client.name });
        if (error) throw error;
        data.clients.push(client);
      }
      const a = { id: uuid(), clientId: client.id, start: starts, minutes: state.minutes, notes: state.notes.trim(), cutId: null };
      const { error } = await sb.from('appointments').insert({ id: a.id, client_id: a.clientId, starts_at: a.start, minutes: a.minutes, notes: a.notes });
      if (error) throw error;
      data.appts.push(a);
      // Ready for the next one, right after this booking
      schedDay = state.day;
      renderSchedule();
      state.booked.push(`${client.name.split(' ')[0]} ${fmtTime(a.start)}`);
      state.client = null; state.notes = ''; state.lenSet = false;
      state.minutes = projection(null).minutes;
      state.at = nextOpen(state.day, state.minutes, (apptEnd(a) - startOfDay(a.start)) / 60000);
      nameEl.value = ''; $('bNotes').value = ''; $('bSuggest').innerHTML = ''; $('bStatus').innerHTML = '';
      $('bDone').hidden = false;
      $('bDone').innerHTML = `${icon('check')}<span>Booked ${esc(state.booked.join(', '))}. Add the next one or close.</span>`;
      draw();
      nameEl.focus();
      const label = state.booked[state.booked.length - 1];
      confirmBooking(a).then(ok => {
        if (!ok) return;
        const i = state.booked.indexOf(label);
        if (i >= 0) state.booked[i] += ' (confirmation emailed)';
        if (wrap.isConnected) $('bDone').innerHTML = `${icon('check')}<span>Booked ${esc(state.booked.join(', '))}. Add the next one or close.</span>`;
        if (location.hash === '#schedule' && !wrap.isConnected) renderSchedule();
      });
    } catch (err) {
      toast('Couldn’t book: ' + (err.message || err) + '. Check your connection and try again.', true);
    }
    btn.disabled = false; btn.textContent = 'Book';
  };

  draw();
}

// ---------- Overdue clients ----------
// Clients past their usual gap. Pick who to email, add openings, send.
let nudge = { picked: null, openings: [], note: '' };
function slotLabel(o) {
  const at = m => {
    const h = Math.floor(m / 60) % 24, mm = m % 60;
    return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
  };
  const ap = m => (Math.floor(m / 60) % 24) < 12 ? 'AM' : 'PM';
  const range = ap(o.from) === ap(o.to) ? `${at(o.from)}–${at(o.to)} ${ap(o.to)}` : `${at(o.from)} ${ap(o.from)}–${at(o.to)} ${ap(o.to)}`;
  return `${DAYS[new Date(o.day).getDay()]} ${range}`;
}
function renderOverdue() {
  const rows = overdueClients();
  const live = emailLive();
  const lastNudge = {};
  for (const e of data.emails) if (e.kind === 'nudge' && (!lastNudge[e.clientId] || e.sentAt > lastNudge[e.clientId])) lastNudge[e.clientId] = e.sentAt;
  const recentlyNudged = id => lastNudge[id] && Date.now() - new Date(lastNudge[id]) < 7 * DAY_MS;
  // Everyone who can get an email starts picked, unless they were emailed this week
  if (!nudge.picked) nudge.picked = new Set(rows.filter(r => canEmail(r.cl) && !recentlyNudged(r.cl.id)).map(r => r.cl.id));
  const photoBy = latestPhotoByClient();
  const today = startOfDay(new Date());
  const week = Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  nudge.openings = nudge.openings.filter(o => o.day >= today.getTime()).sort((a, b) => a.day - b.day || a.from - b.from);
  const picked = rows.filter(r => nudge.picked.has(r.cl.id) && canEmail(r.cl));
  const sample = picked[0] || rows.find(r => canEmail(r.cl));
  const p2 = n => String(n).padStart(2, '0');
  const hhmm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;

  $app.innerHTML = `
    ${topbar('Overdue', '#home')}
    ${rows.length ? `<div class="count-line">${plural(rows.length, 'client')} past their usual cut, with nothing booked</div>
    <div class="group overdue">${rows.map(({ cl, s, late }) => {
      const ok = canEmail(cl);
      const on = ok && nudge.picked.has(cl.id);
      const why = !emailReady ? '' : !cl.email ? 'No email · tap to add one' : !cl.reminders ? 'Unsubscribed from emails' : lastNudge[cl.id] ? `Emailed ${ago(lastNudge[cl.id])}` : '';
      return `<button class="row${on ? ' on' : ''}${ok ? '' : ' off'}" data-id="${cl.id}" ${ok ? `role="checkbox" aria-checked="${on}"` : ''}>
        <span class="check${ok ? '' : ' none'}">${on ? icon('check') : ''}</span>
        ${avatar(cl, photoBy[cl.id])}
        <div class="main">
          <div class="name">${esc(cl.name)}</div>
          <div class="meta">Last cut ${fmtShort(s.last.date)} · every ${everyText(s.every)}</div>
          ${why ? `<div class="meta ${cl.email && cl.reminders ? 'sent' : ''}">${why}</div>` : ''}
        </div>
        <div class="right"><div class="num late">${late}</div><div class="meta">days late</div></div>
      </button>`;
    }).join('')}</div>` : `<div class="placeholder">${icon('check')}<h2>Nobody’s overdue</h2><p>Clients show up here once it’s been noticeably longer than their usual gap between cuts.</p></div>`}

    ${rows.length && emailReady ? `
    <div class="section"><h3>Your openings</h3><span class="muted" style="font-size:13px">tap a day</span></div>
    <div class="days open-days">${week.map(d => {
      const n = nudge.openings.filter(o => o.day === d.getTime()).length;
      return `<button data-day="${d.getTime()}" class="${n ? 'on' : ''}"><span class="w">${DAYS[d.getDay()].slice(0, 2)}</span><span class="d">${d.getDate()}</span><span class="dots">${n ? icon('check') : ''}</span></button>`;
    }).join('')}</div>
    ${nudge.openings.length ? `<div class="group openings">${nudge.openings.map((o, i) => `
      <div class="row">
        <div class="main"><div class="name">${DAYS[new Date(o.day).getDay()]}</div><div class="meta">${new Date(o.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></div>
        <input class="field" type="time" step="900" data-i="${i}" data-k="from" value="${hhmm(o.from)}" aria-label="From">
        <span class="muted">to</span>
        <input class="field" type="time" step="900" data-i="${i}" data-k="to" value="${hhmm(o.to)}" aria-label="Until">
        <button class="icon-btn" data-rm="${i}" aria-label="Remove opening">${icon('x')}</button>
      </div>`).join('')}</div>` : ''}
    <textarea class="field" id="nNote" placeholder="Add a line (optional), e.g. Fades are $5 off this week">${esc(nudge.note)}</textarea>

    ${sample ? `<section class="card preview">
      <div class="eyebrow">Email preview</div>
      <div class="subj">Haircut reminder</div>
      <p>Hi ${esc(sample.cl.name.split(' ')[0])}, your last cut was on ${new Date(sample.s.last.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}, so you’re probably about due. Here’s when I have openings:</p>
      ${nudge.openings.length ? `<ul>${nudge.openings.map(o => `<li>${esc(slotLabel(o))}</li>`).join('')}</ul>` : `<p class="muted">Tap a day above to add your openings.</p>`}
      ${nudge.note.trim() ? `<p>${esc(nudge.note.trim())}</p>` : ''}
      <p>Feel free to message me on Instagram with the time that works and I’ll book you in.</p>
    </section>` : ''}
    ${live ? '' : `<p class="hint">Sending turns on once AWS email is connected (see aws/README.md).</p>`}
    <div class="savebar"><button class="btn btn-red" id="nSend" ${live && picked.length && nudge.openings.length ? '' : 'disabled'}>${icon('mail')}${picked.length ? `Email ${plural(picked.length, 'client')}` : 'Pick clients to email'}</button></div>
    ` : ''}
  `;
  wireBack();
  $app.querySelector('[data-back]').onclick = () => { nudge.picked = null; go('#home'); };
  $app.querySelectorAll('.overdue [data-id]').forEach(b => b.onclick = () => {
    const cl = data.clients.find(c => c.id === b.dataset.id);
    if (!canEmail(cl)) return go('#client-' + cl.id);
    nudge.picked.has(cl.id) ? nudge.picked.delete(cl.id) : nudge.picked.add(cl.id);
    renderOverdue();
  });
  $app.querySelectorAll('.open-days [data-day]').forEach(b => b.onclick = () => {
    const day = +b.dataset.day;
    const has = nudge.openings.some(o => o.day === day);
    if (has) nudge.openings = nudge.openings.filter(o => o.day !== day);
    else {
      const last = nudge.openings[nudge.openings.length - 1];
      nudge.openings.push({ day, from: last ? last.from : 12 * 60, to: last ? last.to : 16 * 60 });
    }
    renderOverdue();
  });
  $app.querySelectorAll('.openings input[type=time]').forEach(inp => inp.onchange = () => {
    const [h, m] = inp.value.split(':').map(Number);
    if (!(h >= 0)) return;
    const o = nudge.openings[+inp.dataset.i];
    o[inp.dataset.k] = h * 60 + (m || 0);
    if (o.to <= o.from) o[inp.dataset.k === 'from' ? 'to' : 'from'] = inp.dataset.k === 'from' ? Math.min(o.from + 60, 23 * 60 + 45) : Math.max(o.to - 60, 0);
    renderOverdue();
  });
  $app.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { nudge.openings.splice(+b.dataset.rm, 1); renderOverdue(); });
  const note = document.getElementById('nNote');
  if (note) note.onchange = () => { nudge.note = note.value; renderOverdue(); };
  const send = document.getElementById('nSend');
  if (send) send.onclick = async () => {
    if (note) nudge.note = note.value;
    send.disabled = true; send.textContent = `Sending ${plural(picked.length, 'email')}…`;
    try {
      const out = await callReminders({ action: 'nudge', clientIds: picked.map(r => r.cl.id), openings: nudge.openings.map(slotLabel), note: nudge.note });
      const ok = out.results.filter(r => r.sent);
      ok.forEach(r => { data.emails.push(toEmail(r.email)); nudge.picked.delete(r.clientId); });
      toast(ok.length === picked.length ? `Emailed ${plural(ok.length, 'client')}` : `Emailed ${ok.length} of ${picked.length}`, ok.length < picked.length);
    } catch (err) {
      toast('Couldn’t send: ' + err.message, true);
    }
    renderOverdue();
  };
}

// ---------- Boot ----------
if (!sb) {
  $app.innerHTML = `<div class="loading"><div>CutFolio isn’t connected to its database yet.<br>Add the Supabase URL, anon key, and login email to <b>config.js</b>.</div></div>`;
} else {
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => start(session), 0); });
}
