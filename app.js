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
const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

let liveUrls = [];
function blobUrl(blob) { const u = URL.createObjectURL(blob); liveUrls.push(u); return u; }
function releaseUrls() { liveUrls.forEach(u => URL.revokeObjectURL(u)); liveUrls = []; }

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : ''); el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4000 : 1800);
}

function openViewer(src, caption) {
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `<button class="close" aria-label="Close">✕</button><img src="${esc(src)}" alt=""><div class="cap">${esc(caption)}</div>`;
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
  return {
    count: cuts.length,
    total: cuts.reduce((s, c) => s + (c.price || 0), 0),
    avgPrice: avg(cuts.map(c => c.price || 0)),
    avgMinutes: avg(timed),
    last: sorted[0],
    first: sorted[sorted.length - 1],
  };
}
function cutsByClient() {
  const by = {};
  for (const c of data.cuts) (by[c.clientId] ||= []).push(c);
  return by;
}

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
  return `<div class="topbar"><button class="back" data-back="${fallback}" aria-label="Back">‹</button><h1>${esc(title)}</h1></div>`;
}
function wireBack() {
  const b = $app.querySelector('[data-back]');
  if (b) b.onclick = () => go(b.dataset.back);
}

// ---------- Sign in ----------
function renderLogin() {
  $app.innerHTML = `
    <form class="login" id="login">
      <div class="brand">Cut<span>Folio</span></div>
      <input type="email" id="email" autocomplete="username" value="${esc(CONFIG.loginEmail || '')}" hidden>
      <input class="field" id="password" type="password" placeholder="Password" autocomplete="current-password" enterkeyhint="go" required>
      <button class="btn-primary" style="box-shadow:none" id="signin">Unlock</button>
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
    $app.innerHTML = `<div class="loading"><div style="text-align:center">Couldn’t load your data.<br>${esc(err.message)}<br><button class="linkbtn" onclick="location.reload()">Try again</button></div></div>`;
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

  const monthCuts = cuts.filter(c => inRange(c, start, end));
  const prevCuts = cuts.filter(c => inRange(c, prevStart, start));
  const revenue = monthCuts.reduce((s, c) => s + (c.price || 0), 0);
  const prevRevenue = prevCuts.reduce((s, c) => s + (c.price || 0), 0);

  // First visit per client decides new vs returning
  const firstVisit = {};
  for (const c of cuts) if (!firstVisit[c.clientId] || c.date < firstVisit[c.clientId]) firstVisit[c.clientId] = c.date;
  const monthClients = [...new Set(monthCuts.map(c => c.clientId))];
  const newCount = monthClients.filter(id => inRange({ date: firstVisit[id] }, start, end)).length;
  const retCount = monthClients.length - newCount;
  const newPct = monthClients.length ? (newCount / monthClients.length) * 100 : 50;

  // Best weekday (by revenue) in the selected month, plus best single date
  const byWeekday = Array(7).fill(0);
  const byDate = {};
  for (const c of monthCuts) {
    const d = new Date(c.date);
    byWeekday[d.getDay()] += c.price || 0;
    const key = d.toDateString();
    byDate[key] = (byDate[key] || 0) + (c.price || 0);
  }
  const maxW = Math.max(...byWeekday);
  const bestW = maxW > 0 ? byWeekday.indexOf(maxW) : -1;
  const bestDate = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0];

  let change = '';
  if (prevRevenue > 0) {
    const pct = Math.round(((revenue - prevRevenue) / prevRevenue) * 100);
    change = `<span class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span> vs last month`;
  } else {
    change = `${monthCuts.length} cut${monthCuts.length === 1 ? '' : 's'}`;
  }
  const monthLabel = ref.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const order = [1, 2, 3, 4, 5, 6, 0];

  $app.innerHTML = `
    <div class="topbar"><div class="brand">Cut<span>Folio</span></div></div>
    <div class="actions">
      <button class="action" data-go="#schedule"><span class="ico">📅</span>View schedule</button>
      <button class="action" data-go="#clients"><span class="ico">👥</span>Client portfolio</button>
      <button class="action primary" data-go="#log"><span class="ico">✂️</span>Log cut</button>
    </div>

    <div class="month-switch">
      <button id="prevM" aria-label="Previous month">‹</button>
      <h2>${monthLabel}</h2>
      <button id="nextM" aria-label="Next month" ${monthOffset >= 0 ? 'disabled' : ''}>›</button>
    </div>

    <div class="grid2">
      <div class="card metric wide">
        <div class="label">Monthly revenue</div>
        <div class="value">${money(revenue)}</div>
        <div class="sub">${change}</div>
      </div>
      <div class="card metric">
        <div class="label">Total customers</div>
        <div class="value">${clients.length}</div>
        <div class="sub">all time</div>
      </div>
      <div class="card metric">
        <div class="label">Cuts this month</div>
        <div class="value">${monthCuts.length}</div>
        <div class="sub">${monthCuts.length ? 'avg ' + money(revenue / monthCuts.length) : '—'}</div>
      </div>
      <div class="card metric wide">
        <div class="label">New vs returning</div>
        <div class="value">${newCount} <span style="color:var(--muted);font-weight:500">/</span> ${retCount}</div>
        <div class="split">${monthClients.length ? `<div class="a" style="width:${newPct}%"></div><div class="b" style="width:${100 - newPct}%"></div>` : ''}</div>
        <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>New ${newCount}</span><span><i class="dot" style="background:#6b8cff"></i>Returning ${retCount}</span></div>
      </div>
      <div class="card metric wide">
        <div class="label">Best day</div>
        <div class="value">${bestW >= 0 ? DAYS[bestW] : '—'}</div>
        <div class="sub">${bestW >= 0 ? money(maxW) + ' on ' + DAYS[bestW] + 's' + (bestDate ? ` · top date ${fmtShort(bestDate[0])} (${money(bestDate[1])})` : '') : 'Log a few cuts to see your best day'}</div>
        <div class="bars">${order.map(i => `<div><i class="${i === bestW ? 'top' : ''}" style="height:${maxW ? Math.max(4, (byWeekday[i] / maxW) * 100) : 4}%"></i><span>${DAYS[i][0]}</span></div>`).join('')}</div>
      </div>
    </div>
    ${cuts.length === 0 ? `<p class="hint">Tap <b>Log cut</b> to add your first client.</p>` : ''}
    <button class="signout" id="signout">Sign out</button>
  `;
  $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  document.getElementById('prevM').onclick = () => { monthOffset--; renderHome(); };
  document.getElementById('nextM').onclick = () => { if (monthOffset < 0) { monthOffset++; renderHome(); } };
  const so = document.getElementById('signout');
  so.onclick = async () => {
    if (!so.dataset.armed) { so.dataset.armed = '1'; so.textContent = 'Tap again to lock (needs the password to reopen)'; return; }
    await sb.auth.signOut();
  };
}

// ---------- Client portfolio ----------
function renderClients() {
  const { clients, cuts, photos } = data;
  const cutsBy = cutsByClient();
  const cutDate = Object.fromEntries(cuts.map(c => [c.id, c.date]));
  const photoBy = {}; // latest photo per client
  for (const p of photos) {
    const cur = photoBy[p.clientId];
    if (!cur || (cutDate[p.cutId] || '') > (cutDate[cur.cutId] || '')) photoBy[p.clientId] = p;
  }
  const rows = clients.map(cl => ({ cl, s: clientStats(cutsBy[cl.id] || []) }))
    .sort((a, b) => (b.s.last?.date || b.cl.createdAt).localeCompare(a.s.last?.date || a.cl.createdAt));

  $app.innerHTML = `
    ${topbar('Client portfolio')}
    <input class="search" id="q" type="search" placeholder="Search clients" autocomplete="off" autocorrect="off">
    <div class="list" id="list"></div>
  `;
  wireBack();
  const list = document.getElementById('list');
  const draw = (q) => {
    const nq = norm(q);
    const hits = rows.filter(r => !nq || norm(r.cl.name).includes(nq) || norm(r.s.last?.style || '').includes(nq));
    if (!rows.length) { list.innerHTML = `<div class="empty">No clients yet.<br><button class="linkbtn" data-go="#log">Log your first cut</button></div>`; }
    else if (!hits.length) { list.innerHTML = `<div class="empty">No one named “${esc(q)}”.</div>`; }
    else list.innerHTML = hits.map(({ cl, s }) => {
      const p = photoBy[cl.id];
      return `<button class="row" data-id="${cl.id}">
        <div class="avatar">${p ? `<img src="${esc(thumbUrl(p))}" alt="" loading="lazy">` : esc(initials(cl.name))}</div>
        <div class="main"><div class="name">${esc(cl.name)}</div>
          <div class="meta">${s.count} cut${s.count === 1 ? '' : 's'}${s.last ? ' · last ' + fmtShort(s.last.date) : ''}</div></div>
        <div class="right">${s.count ? money(s.avgPrice) : ''}<div class="meta" style="font-weight:400">${s.count ? 'avg' : ''}</div></div>
      </button>`;
    }).join('');
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
  const cover = mine[0];

  $app.innerHTML = `
    ${topbar('', '#clients')}
    <div class="profile-head">
      <div class="avatar">${cover ? `<img src="${esc(thumbUrl(cover))}" alt="">` : esc(initials(client.name))}</div>
      <div><h2>${esc(client.name)}</h2>
        <div class="meta">${s.first ? 'Client since ' + fmtDate(s.first.date) : 'No cuts yet'}</div>
        <button class="linkbtn" id="rename">Edit name</button>
        <form id="renameForm" class="rename" hidden><input class="field" id="renameInput" style="padding:8px 10px"><button class="chip on" type="submit">Save</button></form></div>
    </div>
    <div class="stats">
      <div class="card metric"><div class="label">Avg price</div><div class="value">${s.count ? money(s.avgPrice) : '—'}</div></div>
      <div class="card metric"><div class="label">Avg time</div><div class="value">${s.avgMinutes ? Math.round(s.avgMinutes) + ' min' : '—'}</div></div>
      <div class="card metric"><div class="label">Total cuts</div><div class="value">${s.count}</div></div>
      <div class="card metric"><div class="label">Total spent</div><div class="value">${money(s.total)}</div></div>
    </div>
    <button class="btn-primary" style="margin-top:16px;box-shadow:none" id="logFor">✂️ Log cut for ${esc(client.name.split(' ')[0])}</button>

    <div class="section-title">Previous cuts</div>
    ${mine.length ? `<div class="gallery">${mine.map(p => `<button data-photo="${p.id}"><img src="${esc(thumbUrl(p))}" alt="" loading="lazy"><span class="date">${cutById[p.cutId] ? fmtShort(cutById[p.cutId].date) : ''}</span></button>`).join('')}</div>`
      : `<div class="card empty" style="padding:24px">No photos yet</div>`}

    <div class="section-title">Transaction history</div>
    ${history.length ? `<div class="card" style="padding:0">${history.map(c => `
      <div class="txn">
        <div class="main"><div>${fmtDate(c.date)}</div>
          <div class="meta">${[c.style, c.minutes ? c.minutes + ' min' : '', c.notes].filter(Boolean).map(esc).join(' · ') || 'Haircut'}</div></div>
        <div class="right" style="font-weight:650">${money(c.price || 0)}</div>
        <button class="del" data-del="${c.id}" aria-label="Delete">✕</button>
      </div>`).join('')}</div>` : `<div class="card empty" style="padding:24px">No transactions yet</div>`}
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
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete?'; b.style.color = 'var(--bad)'; return; }
    const cutId = b.dataset.del;
    b.disabled = true;
    const ph = data.photos.filter(p => p.cutId === cutId);
    const { error } = await sb.from('cuts').delete().eq('id', cutId); // photo rows go with it
    if (error) { b.disabled = false; return toast('Couldn’t delete: ' + error.message, true); }
    if (ph.length) await sb.storage.from(BUCKET).remove(ph.flatMap(p => [p.path, p.thumbPath]));
    data.cuts = data.cuts.filter(c => c.id !== cutId);
    data.photos = data.photos.filter(p => p.cutId !== cutId);
    renderClient(id);
  });
}

// ---------- Log cut ----------
const PRICE_CHIPS = [25, 30, 35, 40, 50];
const TIME_CHIPS = [20, 30, 45, 60];
function renderLog(presetId) {
  const { clients } = data;
  const cutsBy = cutsByClient();

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
    ${topbar('Log cut', presetId ? '#client-' + presetId : '#home')}
    <div class="seg" id="seg">
      <button data-mode="returning">Returning client</button>
      <button data-mode="new">New client</button>
    </div>
    <div class="ac">
      <label class="label" for="name">Client name</label>
      <input class="field" id="name" placeholder="Start typing a name…" autocomplete="off" autocorrect="off" autocapitalize="words" enterkeyhint="done">
      <div id="suggest"></div>
      <div id="status"></div>
    </div>

    <label class="label">Photos</label>
    <div class="photo-btns">
      <button class="photo-btn" id="takePhoto"><span class="ico">📷</span>Take photo</button>
      <button class="photo-btn" id="uploadPhoto"><span class="ico">🖼️</span>Upload from library</button>
    </div>
    <div class="thumbs" id="thumbs"></div>

    <label class="label" for="price">Price</label>
    <div class="money"><input class="field" id="price" inputmode="decimal" placeholder="0" enterkeyhint="done"></div>
    <div class="chips" id="priceChips">${PRICE_CHIPS.map(p => `<button class="chip" data-v="${p}">$${p}</button>`).join('')}</div>

    <label class="label">Time</label>
    <div class="chips" id="timeChips">${TIME_CHIPS.map(m => `<button class="chip" data-v="${m}">${m} min</button>`).join('')}
      <input class="field" id="minutes" inputmode="numeric" placeholder="Other" style="width:96px;padding:9px 12px;border-radius:999px;font-size:15px"></div>

    <details class="more" id="more">
      <summary>+ Style, notes, date</summary>
      <label class="label" for="style">Style</label>
      <input class="field" id="style" placeholder="e.g. Low fade, #2 on sides" autocapitalize="sentences">
      <label class="label" for="notes">Notes</label>
      <textarea class="field" id="notes" placeholder="Anything to remember next time"></textarea>
      <label class="label" for="date">Date &amp; time</label>
      <input class="field" id="date" type="datetime-local">
    </details>

    <div class="savebar"><button class="btn-primary" id="save">Save cut</button></div>
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
      statusEl.innerHTML = `<span class="pill ret">✓ Returning · ${s.count} cut${s.count === 1 ? '' : 's'}${s.last ? ', last ' + fmtShort(s.last.date) : ''}</span>`;
    } else if (typed) {
      const dup = clients.find(c => norm(c.name) === norm(typed));
      statusEl.innerHTML = dup
        ? `<span class="pill ret">“${esc(dup.name)}” already exists. <u>Tap to use</u></span>`
        : `<span class="pill new">＋ New client will be added</span>`;
      if (dup) statusEl.firstChild.onclick = () => pick(dup);
    } else statusEl.innerHTML = '';
  }
  function drawSuggest() {
    const q = norm(nameEl.value);
    if (state.mode !== 'returning' || state.client || !q) { sugEl.innerHTML = ''; return; }
    const hits = clients
      .filter(c => norm(c.name).includes(q))
      .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 5);
    sugEl.innerHTML = hits.length ? `<div class="suggest">${hits.map(c => {
      const s = clientStats(cutsBy[c.id] || []);
      return `<button data-id="${c.id}"><b>${esc(c.name)}</b><span class="meta">${s.last ? 'last ' + fmtShort(s.last.date) : ''}</span></button>`;
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
    $('thumbs').innerHTML = state.files.map((f, i) => `<div class="thumb"><img src="${f.url}" alt=""><button data-i="${i}" aria-label="Remove">✕</button></div>`).join('');
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
      go('#client-' + client.id);
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
    <div class="placeholder"><div class="ico">📅</div><h2>Coming soon</h2><p>Your schedule will live here.</p></div>
  `;
  wireBack();
}

// ---------- Boot ----------
if (!sb) {
  $app.innerHTML = `<div class="loading"><div style="text-align:center">CutFolio isn’t connected to its database yet.<br>Add the Supabase URL, anon key, and login email to <b>config.js</b>.</div></div>`;
} else {
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => start(session), 0); });
}
