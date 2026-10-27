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
const data = { clients: [], cuts: [], photos: [] };
const photoUrls = {}; // storage path -> signed URL
let user = null;

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
const toClient = r => ({ id: r.id, name: r.name, createdAt: r.created_at });
const toCut = r => ({ id: r.id, clientId: r.client_id, date: new Date(r.date).toISOString(), price: Number(r.price), minutes: r.minutes, style: r.style, notes: r.notes });
const toPhoto = r => ({ id: r.id, cutId: r.cut_id, clientId: r.client_id, path: r.path, thumbPath: r.thumb_path });

async function loadData() {
  const [clients, cuts, photos] = await Promise.all([fetchAll('clients'), fetchAll('cuts'), fetchAll('photos')]);
  data.clients = clients.map(toClient);
  data.cuts = cuts.map(toCut);
  data.photos = photos.map(toPhoto);
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
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
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
const avatar = (client, photo) => `<div class="avatar">${photo ? `<img src="${esc(thumbUrl(photo))}" alt="" loading="lazy">` : esc(initials(client.name))}</div>`;
const everyText = days => days < 10 ? `${Math.round(days)} days` : `${Math.round(days / 7)} weeks`;

// ---------- Router ----------
const routes = [
  [/^#?(?:home)?$/, renderHome],
  [/^#clients$/, renderClients],
  [/^#client-([\w-]+)$/, renderClient],
  [/^#log(?:-([\w-]+))?$/, renderLog],
  [/^#schedule$/, renderSchedule],
];
function route() {
  releaseUrls();
  if (!user) return;
  const hash = location.hash || '#home';
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
      <button class="btn btn-tile" data-go="#schedule">${icon('calendar')}View schedule</button>
    </div>

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
    <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search by name or style" autocomplete="off" autocorrect="off"></label>
    <div class="count-line" id="count"></div>
    <div id="list"></div>
  `;
  wireBack();
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

  $app.innerHTML = `
    ${topbar('', '#clients')}
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
    ${s.every ? `<div class="rhythm">${s.due ? '<span class="pill due">Due</span>' : ''}<span>Comes in about every <b>${everyText(s.every)}</b>. Last cut ${ago(s.last.date)}.</span></div>` : ''}

    <button class="btn btn-red" id="logFor">${icon('scissors')}Log a cut for ${esc(first)}</button>

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
    toast(`Removed ${client.name}`);
    go('#clients');
  };
}
async function removeFiles(photos) {
  const paths = photos.flatMap(p => [p.path, p.thumbPath]);
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
}

// ---------- Log cut ----------
const PRICE_CHIPS = [25, 30, 35, 40, 50];
const TIME_CHIPS = [20, 30, 45, 60];
function renderLog(presetId) {
  const { clients } = data;
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

  function applyClientDefaults() {
    const s = clientStats(cutsBy[state.client.id] || []);
    if (s.last) {
      state.price = String(s.last.price ?? '');
      state.minutes = s.avgMinutes ? String(Math.round(s.avgMinutes / 5) * 5) : '';
      state.style = s.last.style || '';
    }
  }

  $app.innerHTML = `
    ${topbar('Log a cut', presetId ? '#client-' + presetId : '#home')}
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
      go('#home');
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

// ---------- Schedule (placeholder, built last) ----------
function renderSchedule() {
  $app.innerHTML = `
    ${topbar('Schedule')}
    <div class="placeholder">${icon('calendar')}<h2>Coming soon</h2><p>Bookings and your week at a glance will live here.</p></div>
  `;
  wireBack();
}

// ---------- Boot ----------
if (!sb) {
  $app.innerHTML = `<div class="loading"><div>CutFolio isn’t connected to its database yet.<br>Add the Supabase URL, anon key, and login email to <b>config.js</b>.</div></div>`;
} else {
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => start(session), 0); });
}
