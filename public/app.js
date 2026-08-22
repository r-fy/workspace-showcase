'use strict';

// ── Config ────────────────────────────────────────────────────
const API = '/api';
const CLAUDE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="10.5" y="2" width="3" height="20" rx="1.5"/><rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(30 12 12)"/><rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(60 12 12)"/><rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(90 12 12)"/><rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(120 12 12)"/><rect x="10.5" y="2" width="3" height="20" rx="1.5" transform="rotate(150 12 12)"/></svg>';
let authHeader = null;

// ── State ─────────────────────────────────────────────────────
let notes = [];
let notesFullCache = {};   // id → full note object
let currentNoteId = null;
let saveNoteTimer = null;
let activeTag = null;

let expenses = [];
let expenseCategories = [];
let activeExpenseCat = null;
let currentExpenseId = null;
let expenseSortCols = [];
const selectedExpenses = new Set();
let lastClickedExpenseId = null;
let expenseChartVisible = localStorage.getItem('expense-chart-visible') !== '0';
let expenseFilterYear = localStorage.getItem('expense-filter-year') || 'all';
let expenseFilterMonth = localStorage.getItem('expense-filter-month') || 'all';
let expenseFilterSource = localStorage.getItem('expense-filter-source') || 'all';
let expenseSearchQuery = localStorage.getItem('expense-search') || '';

let reminders = [];
let currentReminderId = null;
const remWeekdaySel = new Set();
let calendarViewMode = localStorage.getItem('calendar-view-mode') === 'month' ? 'month' : 'agenda';
let calendarMonthVisible = localStorage.getItem('calendar-month-visible') !== '0';

let calls = [];
let smsMessages = []; // Texts panel — shares the dial-number input as its "to" target, no separate composer state
let twDevice = null;        // Twilio Voice Device (created lazily on first Calls-tab open)
let twCall = null;          // active Call, null when idle
let twDialing = false;      // set synchronously on Call click — twCall only exists after connect() resolves
let twTokenAt = 0;          // when the current token was fetched (epoch ms)
let dialerCallerId = '';
let callTimerInt = null;
const recUrlCache = new Map(); // recording_sid → blob object URL (kept for the session — re-listens are free)

let boards = [];
let currentBoardId = null;
let currentBoardData = [];
let selectedTasks = new Set();
let modalTaskId = null;
let newTaskColId = null;
let modalClaudeMarked = false;
let modalTaskTags = [];   // array of tag names being edited in the open task modal
let activeTaskTag = null; // Projects tag filter, scoped to the current board
let dragColId = null;
let dragBoardId = null;
let dragNoteId = null;
let mobileColIdx = 0;
let allColumns = [];

let coldEmailDaily = [];
let coldEmailAccounts = [];
let coldEmailReplies = [];
let coldEmailStatus = null;
let coldEmailDays = 30;
const ceChartHiddenSeries = new Set();

let outbox = [];
let idb = null;

let noteEditor = null;  // current CM6 EditorView for notes
let taskEditor = null;  // current CM6 EditorView for task modal
let tocTimer = null;

// ── IDB ───────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('workspace', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      ['notes','boards','columns','tasks'].forEach(name => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'oid', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
const idbGet = (store, key) => new Promise((res, rej) => { const r = idb.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGetAll = store => new Promise((res, rej) => { const r = idb.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbPut = (store, val) => new Promise((res, rej) => { const r = idb.transaction(store,'readwrite').objectStore(store).put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
const idbDelete = (store, key) => new Promise((res, rej) => { const r = idb.transaction(store,'readwrite').objectStore(store).delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
const idbClear = store => new Promise((res, rej) => { const r = idb.transaction(store,'readwrite').objectStore(store).clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
function idbPutAll(store, items) {
  return new Promise((res, rej) => {
    const tx = idb.transaction(store,'readwrite'); const os = tx.objectStore(store);
    items.forEach(i => os.put(i)); tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
// Every queued write carries an id that never changes, even across retries.
// The server remembers ids it has already carried out, so a write that reached
// the database but whose reply got lost on the way back is recognised on the
// replay instead of being done twice.
function newOpId() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}
// Waits for the write to actually land on disk. An op that only made it into
// the in-memory array is lost on reload, and the caller would have told the user
// "saved, will sync later" — so a failure here has to be a failure the caller sees.
function enqueueOp(op) {
  if (!op.opId) op.opId = newOpId();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('outbox', 'readwrite');
    const req = tx.objectStore('outbox').add(op);
    req.onsuccess = () => { op.oid = req.result; };
    tx.oncomplete = () => { outbox.push(op); resolve(op); };
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('could not queue offline change'));
  });
}
// A catch block around apiCall must NOT queue the write itself when we're
// offline — apiCall already did, and queuing it again creates the row twice on
// reconnect (two notes, two tasks). The catch also fires for ordinary server
// errors while online, and THAT case does still need queuing, hence the check.
async function queueForSync(op) {
  if (!navigator.onLine) return;
  try { await enqueueOp(op); }
  catch (e) { toast('Saved on this device only — could not queue it to sync'); }
}

// Order is the point here. The old version emptied the queue, retried each op,
// and pushed failures onto the END — so an edit could land after the delete
// that was queued before it and bring deleted content back. Now a retriable
// failure stops the flush with the queue intact and in order.
async function flushOutbox() {
  if (!navigator.onLine || outbox.length === 0) return;
  while (outbox.length) {
    const op = outbox[0];
    try {
      await apiFetch(op.method, op.path, op.body, op.opId);
    } catch (e) {
      if (e && e.retriable) return;        // offline / server hiccup / logged out — try again later, keep the order
      // The server refused this specific write (bad request, gone, etc).
      // Retrying it forever would wedge everything queued behind it.
      console.warn('dropping a queued change the server refused:', op.method, op.path, e && e.message);
    }
    outbox.shift();
    if (op.oid !== undefined) { try { await idbDelete('outbox', op.oid); } catch(e) {} }
  }
  await fullSync();
}

// ── API ───────────────────────────────────────────────────────
// Errors carry a `retriable` flag so flushOutbox can tell "try again later"
// (offline, server hiccup, logged out) from "the server refused this write".
async function apiFetch(method, path, body, opId) {
  const opts = { method, headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } };
  if (opId) opts.headers['Idempotency-Key'] = opId;
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(API + path, opts); }
  catch (e) { e.retriable = true; throw e; }
  if (res.status === 401) { showLogin(); const e = new Error('Unauthorized'); e.retriable = true; throw e; }
  if (res.status === 429 || res.status >= 500) { const e = new Error(await res.text()); e.retriable = true; throw e; }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiCall(method, path, body) {
  if (!navigator.onLine) {
    if (method !== 'GET') {
      // If the change can't even be written to the offline queue, say so — the
      // caller's "will sync when reconnected" message would otherwise be a lie.
      try { await enqueueOp({ method, path, body }); }
      catch (e) { throw new Error('could not save this change for later — storage is full or unavailable'); }
    }
    throw new Error('offline');
  }
  return apiFetch(method, path, body);
}

// ── Sync ──────────────────────────────────────────────────────
// /api/sync is polled every 2s and almost always has nothing new in it, so the
// server fingerprints the payload and we hand the last fingerprint back. An
// unchanged one comes back as a few bytes instead of the whole database.
// X-Sync-Version, not ETag: ETag means something to Express, Cloudflare and the
// browser cache alike, and Express answers a matching If-None-Match with an
// empty 304 before our JSON is ever sent. A private header nobody else reads.
let lastSyncVersion = null;
async function fetchSync(useVersion) {
  const headers = { 'Authorization': authHeader };
  if (useVersion && lastSyncVersion) headers['X-Sync-Version'] = lastSyncVersion;
  const res = await fetch(API + '/sync', { headers, cache: 'no-store' });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(await res.text());
  const version = res.headers.get('X-Sync-Version');
  const data = await res.json();
  if (data && data.unchanged) return null;   // nothing new since the last poll
  lastSyncVersion = version;
  return data;
}

async function fullSync() {
  try {
    const data = await fetchSync(false);
    await Promise.all([
      idbClear('notes').then(() => idbPutAll('notes', data.notes)),
      idbClear('boards').then(() => idbPutAll('boards', data.boards)),
      idbClear('columns').then(() => idbPutAll('columns', data.columns)),
      idbClear('tasks').then(() => idbPutAll('tasks', data.tasks)),
    ]);
    data.notes.forEach(n => { if (notesFullCache[n.id]) notesFullCache[n.id] = n; });
    notes = data.notes; boards = data.boards; allColumns = data.columns;
    reminders = data.reminders || [];
    calls = data.calls || [];
    smsMessages = data.sms || [];
    applyProspectSyncData(data);
    renderNotesList(); renderTagsBar(); renderBoardsBar();
    if (currentTab === 'calendar') renderCalendarActive();
    if ((currentTab === 'crm' && crmSubTab === 'calls') || currentTab === 'dialer') { renderCallLog({ fromPoll: true }); renderSmsLog(); }
    if (currentBoardId) await loadBoard(currentBoardId);
  } catch(e) {
    notes = await idbGetAll('notes'); boards = await idbGetAll('boards');
    allColumns = await idbGetAll('columns');
    notes.sort((a,b) => (a.position??0) - (b.position??0));
    renderNotesList(); renderTagsBar(); renderBoardsBar();
    if (currentBoardId) await loadBoardOffline(currentBoardId);
  }
}

// ── Live polling ──────────────────────────────────────────────
let pollTimer = null;
// There used to be a second, hand-written change check here (hashData) covering
// only some of the synced tables. Now that the server fingerprints the whole
// payload, that check could only ever be wrong in one direction: it looked at
// notes/tasks/reminders/calls/sms/prospects but NOT boards, columns, prospect
// lists or the daily stats — so a board rename or a column reorder from another
// device arrived, got compared, and was thrown away. The server fingerprint is
// exact, so it is now the only gate.

// Prospect lists ride /api/sync (like reminders/calls) so an outside change —
// e.g. the future n8n scrape workflow inserting rows, or another device
// updating an outcome — shows up live without a manual refresh. Sidebar
// counts always refresh; the open list's row data only refreshes while the
// Dialer tab is actually showing.
let allProspects = []; // every prospect across every list — for the call log's name lookup, not scoped to whichever list is open
function applyProspectSyncData(data) {
  prospectLists = data.prospect_lists || [];
  allProspects = data.prospects || [];
  if (currentTab !== 'dialer') return;
  if (prospectStatsDate === null && data.prospect_stats_today) renderProspectStatsBar(data.prospect_stats_today);
  renderProspectListsPanel();
  if (currentProspectListId && currentProspectList) {
    currentProspectList.prospects = (data.prospects || []).filter(p => p.list_id === currentProspectListId).map(p => {
      const pending = pendingProspectOutcomes[p.id];
      if (pending === undefined) return p;
      if (p.outcome === pending) { delete pendingProspectOutcomes[p.id]; return p; }
      return { ...p, outcome: pending }; // PUT hasn't landed in this snapshot yet — keep the user's pick
    });
    renderProspectListView();
  }
}

function buildBoardData(boardId, columns, tasks) {
  return columns
    .filter(c => c.board_id === boardId)
    .sort((a, b) => a.position - b.position)
    .map(c => ({ ...c, tasks: tasks.filter(t => t.column_id === c.id).sort((a, b) => a.position - b.position) }));
}

async function pollSync() {
  if (!authHeader || !navigator.onLine) return;
  if (modalTaskId) return;
  try {
    const data = await fetchSync(true);
    if (!data) return;              // fingerprint matched — nothing changed
    await Promise.all([
      idbClear('notes').then(() => idbPutAll('notes', data.notes)),
      idbClear('boards').then(() => idbPutAll('boards', data.boards)),
      idbClear('columns').then(() => idbPutAll('columns', data.columns)),
      idbClear('tasks').then(() => idbPutAll('tasks', data.tasks)),
    ]);
    data.notes.forEach(n => { if (notesFullCache[n.id]) notesFullCache[n.id] = n; });
    notes = data.notes; boards = data.boards; allColumns = data.columns;
    reminders = data.reminders || [];
    calls = data.calls || [];
    smsMessages = data.sms || [];
    applyProspectSyncData(data);
    renderNotesList(); renderTagsBar(); renderBoardsBar();
    if (currentTab === 'calendar') renderCalendarActive();
    if ((currentTab === 'crm' && crmSubTab === 'calls') || currentTab === 'dialer') { renderCallLog({ fromPoll: true }); renderSmsLog(); }
    // Push updated content into open note editor if not actively focused
    if (currentNoteId && noteEditor) {
      const remote = data.notes.find(n => n.id === currentNoteId);
      const local  = notesFullCache[currentNoteId];
      if (remote && local && remote.updated_at > (local.updated_at || 0)) {
        const focused = document.activeElement?.closest('#note-cm-mount');
        if (!focused && remote.content != null && remote.content !== WEditor.getText(noteEditor)) {
          WEditor.setText(noteEditor, remote.content);
        }
      }
    }
    if (currentBoardId) {
      currentBoardData = buildBoardData(currentBoardId, data.columns, data.tasks);
      renderKanban();
    }
  } catch(e) {}
}

function startPolling() { stopPolling(); pollTimer = setInterval(pollSync, 2000); }
function stopPolling()  { clearInterval(pollTimer); pollTimer = null; }

// ── Markdown ──────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Toast ──────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Auth ───────────────────────────────────────────────────────
// The PIN buys a session token at /api/auth/login and is then forgotten. What
// gets stored in sessionStorage, the /uploads cookie and the service worker's
// IndexedDB is that token — revocable (the lock button kills it server-side)
// and expiring, unlike the PIN it replaced.
// <img> tags can't send the Authorization header, so /uploads images are
// authenticated via this cookie carrying the same credential (server checks both).
function setUploadsCookie() {
  document.cookie = 'ws_auth=' + encodeURIComponent(authHeader) + '; path=/uploads; SameSite=Strict' + (location.protocol === 'https:' ? '; Secure' : '');
}
function clearUploadsCookie() {
  document.cookie = 'ws_auth=; path=/uploads; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}
// The service worker needs the credential too (notification action buttons hit
// the API while the app may be closed, and the ws_auth cookie never reaches
// /api). Mirrored into a tiny dedicated IDB the SW reads — see sw.js swGetAuth.
function swAuthDb() {
  return new Promise(resolve => {
    const open = indexedDB.open('ws-push', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
  });
}
async function mirrorAuthForSw() {
  const dbi = await swAuthDb();
  if (!dbi) return;
  dbi.transaction('kv', 'readwrite').objectStore('kv').put(authHeader, 'authHeader');
  dbi.close();
}
async function clearSwAuth() {
  const dbi = await swAuthDb();
  if (!dbi) return;
  dbi.transaction('kv', 'readwrite').objectStore('kv').delete('authHeader');
  dbi.close();
}
// Locking revokes the token on the server, so the copy left in browser storage
// is dead rather than merely hidden.
async function logout() {
  const had = authHeader;
  if (had) { try { await apiFetch('POST', '/auth/logout'); } catch(e) {} }
  authHeader = null;
  lastSyncVersion = null;
  showLogin();
}
function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  sessionStorage.removeItem('ws_auth');
  clearUploadsCookie();
  clearSwAuth();
  pinBuffer = ''; updatePinDots();
}
async function tryLogin(pin) {
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    if (res.status === 429) throw new Error('Too many attempts');
    if (!res.ok) throw new Error('Unauthorized');
    const { token } = await res.json();
    authHeader = 'Bearer ' + token;
    sessionStorage.setItem('ws_auth', authHeader);
    setUploadsCookie();
    mirrorAuthForSw();
    refreshPushSubscription(); // fresh PIN login path was missing this — restore-path only before
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    if (isMobile()) document.getElementById('left-panel').classList.add('collapsed');
    await fullSync();
    initNavTabsBar();
    outbox = await idbGetAll('outbox');
    if (outbox.length) flushOutbox();
    startPolling();
    initDialer(); // v161: register for inbound calls from any tab, not just when CRM opens
  } catch(e) {
    authHeader = null;
    const err = document.getElementById('login-error');
    const msg = String(e?.message || '');
    err.textContent = msg.includes('Unauthorized') ? 'Wrong PIN.'
      : msg.includes('Too many') ? 'Too many attempts — wait a few minutes.'
      : "Can't reach server — check connection.";
    err.classList.remove('hidden');
    pinBuffer = ''; updatePinDots();
    setTimeout(() => err.classList.add('hidden'), 2600);
  }
}

// ── PIN pad ────────────────────────────────────────────────────
// Deliberately does NOT know or ask the server how long the PIN is — that would let
// anyone learn the length from the network tab (or by watching the dot count) before
// typing a single digit. Dots are grown one at a time as you type instead of a fixed
// row revealing the total up front, and there's no auto-submit-at-N-digits (which would
// require knowing N) — you submit with ✓ or Enter whenever you're done.
const PIN_MAX = 16; // sane upper bound on buffer growth, not the real PIN's length
let pinBuffer = '';
function updatePinDots() {
  const wrap = document.getElementById('pin-dots');
  if (!wrap) return;
  wrap.innerHTML = Array.from({ length: pinBuffer.length }, () => `<span class="pin-dot filled"></span>`).join('');
}
function pinDigit(d) {
  if (pinBuffer.length >= PIN_MAX) return;
  pinBuffer += d; updatePinDots();
}
function pinBack() { pinBuffer = pinBuffer.slice(0, -1); updatePinDots(); }
function pinSubmit() { if (pinBuffer.length) tryLogin(pinBuffer); }

// ── Mobile sidebar ─────────────────────────────────────────────
let currentTab = 'notes';
function openSidebar() {
  document.getElementById('left-panel')?.classList.remove('collapsed');
  if (isMobile()) document.getElementById('sidebar-overlay')?.classList.add('active');
}
function closeSidebar() {
  document.getElementById('left-panel')?.classList.add('collapsed');
  document.getElementById('sidebar-overlay')?.classList.remove('active');
}
function isMobile() { return window.innerWidth <= 640; }

// ── Tabs ───────────────────────────────────────────────────────
// Desktop-only browser-style tab strip next to the header search bar (v155).
// Mirrors an actual browser tab bar: starts with just the last-open tab(s)
// restored from localStorage, a tab opens the first time you switch to that
// section (not all 10 sections up front), stays open until you close it (✕),
// and can be dragged to reorder. The left-panel nav dropdown (v141) is the
// only way to open a NEW tab — this strip just reflects what's already open.
const NAV_TAB_LABELS = {
  todo: 'To Do',
  notes: 'Notes', tasks: 'Projects', expenses: 'Expenses', calendar: 'Calendar',
  crm: 'CRM', dialer: 'Dialer', 'daily-tasks': 'TRW Daily Tasks',
  tourist: 'Tourist', 'cold-email': 'Cold Email', archive: 'Archive', connections: 'Connections',
};
// Tab renames across versions: the old Leads/Audits/Follow-ups tabs collapsed
// into CRM (v160); the old Calls tab is the standalone Dialer again (v162).
// Map anything saved in localStorage so nobody loses their spot.
const TAB_MIGRATIONS = { calls: 'dialer', leads: 'crm', audits: 'crm', followups: 'crm' };
let openNavTabs = [];
let navTabDragEl = null;

function loadOpenNavTabs() {
  try { openNavTabs = JSON.parse(localStorage.getItem('nav-open-tabs') || 'null') || ['notes']; }
  catch (e) { openNavTabs = ['notes']; }
  openNavTabs = [...new Set(openNavTabs.map(t => TAB_MIGRATIONS[t] || t))].filter(t => NAV_TAB_LABELS[t]);
  if (!openNavTabs.length) openNavTabs = ['notes'];
}
function saveOpenNavTabs() { localStorage.setItem('nav-open-tabs', JSON.stringify(openNavTabs)); }

function renderNavTabsBar() {
  const bar = document.getElementById('nav-tabs-bar');
  if (!bar) return;
  bar.innerHTML = openNavTabs.map(tab => `
    <div class="nav-tab${tab === currentTab ? ' active' : ''}" draggable="true" data-tab="${tab}" title="Middle-click to close">
      <span class="nav-tab-label">${escHtml(NAV_TAB_LABELS[tab] || tab)}</span>
    </div>`).join('');
  bar.querySelectorAll('.nav-tab').forEach(el => {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
    // Middle-click closes the tab instead of a dedicated ✕ button — mousedown
    // prevents the middle-click autoscroll cursor some browsers show on Windows/Linux.
    el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('auxclick', e => { if (e.button === 1) closeNavTab(el.dataset.tab); });
    el.addEventListener('dragstart', e => { navTabDragEl = el; e.dataTransfer.setData('nav-tab-drag', el.dataset.tab); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { navTabDragEl = null; bar.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('dragging', 'drop-before', 'drop-after')); });
    el.addEventListener('dragover', e => {
      if (!Array.from(e.dataTransfer.types).includes('nav-tab-drag') || el === navTabDragEl) return;
      e.preventDefault();
      const before = e.clientX < el.getBoundingClientRect().left + el.offsetWidth / 2;
      el.classList.toggle('drop-before', before); el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (!navTabDragEl || el === navTabDragEl) return;
      const before = el.classList.contains('drop-before');
      el.classList.remove('drop-before', 'drop-after');
      openNavTabs = openNavTabs.filter(t => t !== navTabDragEl.dataset.tab);
      const idx = openNavTabs.indexOf(el.dataset.tab);
      openNavTabs.splice(before ? idx : idx + 1, 0, navTabDragEl.dataset.tab);
      saveOpenNavTabs(); renderNavTabsBar();
    });
  });
}

function closeNavTab(tab) {
  const idx = openNavTabs.indexOf(tab);
  if (idx === -1) return;
  openNavTabs.splice(idx, 1);
  if (!openNavTabs.length) openNavTabs = ['notes'];
  saveOpenNavTabs();
  if (tab === currentTab) {
    const fallback = openNavTabs[idx] || openNavTabs[idx - 1] || openNavTabs[0];
    switchTab(fallback);
  } else {
    renderNavTabsBar();
  }
}

function initNavTabsBar() {
  loadOpenNavTabs();
  let active = null;
  try { active = localStorage.getItem('nav-active-tab'); } catch (e) {}
  if (active && TAB_MIGRATIONS[active]) active = TAB_MIGRATIONS[active];
  if (!active || !openNavTabs.includes(active)) active = openNavTabs[0];
  switchTab(active);
}

// Ctrl+Tab/Ctrl+PageDown and Ctrl+Shift+Tab/Ctrl+PageUp cycle the open nav
// tabs, mirroring a real browser's tab-switch shortcuts. Ctrl+Shift+PageUp/
// PageDown instead MOVES the active tab left/right (also a real browser
// convention). Only takes effect if the browser hands the keystroke to the
// page at all — Chrome/Brave reserve these for their own tab strip in a
// normal browser tab, but a standalone installed PWA window has no tab strip
// of its own to compete with, so the shortcuts are free there.
function moveActiveNavTab(step) {
  const idx = openNavTabs.indexOf(currentTab);
  if (idx === -1) return;
  const swapWith = (idx + step + openNavTabs.length) % openNavTabs.length;
  [openNavTabs[idx], openNavTabs[swapWith]] = [openNavTabs[swapWith], openNavTabs[idx]];
  saveOpenNavTabs(); renderNavTabsBar();
}
document.addEventListener('keydown', e => {
  if (!e.ctrlKey || !openNavTabs.length) return;
  const isNext = e.key === 'PageDown' || (e.key === 'Tab' && !e.shiftKey);
  const isPrev = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey);
  if (!isNext && !isPrev) return;
  e.preventDefault();
  const step = isNext ? 1 : -1;
  if (e.shiftKey && e.key !== 'Tab') { moveActiveNavTab(step); return; }
  const idx = openNavTabs.indexOf(currentTab);
  const next = openNavTabs[(idx + step + openNavTabs.length) % openNavTabs.length];
  switchTab(next);
});

function switchTab(tab) {
  currentTab = tab;
  if (!openNavTabs.includes(tab)) openNavTabs.push(tab);
  saveOpenNavTabs();
  try { localStorage.setItem('nav-active-tab', tab); } catch (e) {}
  renderNavTabsBar();
  closeNavDropdown();
  document.querySelectorAll('.nav-menu-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('todo-view')?.classList.toggle('hidden', tab !== 'todo');
  document.getElementById('notes-view').classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-view').classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-view')?.classList.toggle('hidden', tab !== 'expenses');
  document.getElementById('calendar-view')?.classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('trash-view')?.classList.toggle('hidden', tab !== 'trash');
  document.getElementById('archive-view')?.classList.toggle('hidden', tab !== 'archive');
  document.getElementById('crm-view')?.classList.toggle('hidden', tab !== 'crm');
  document.getElementById('dialer-view')?.classList.toggle('hidden', tab !== 'dialer');
  document.getElementById('tourist-view')?.classList.toggle('hidden', tab !== 'tourist');
  document.getElementById('daily-tasks-view')?.classList.toggle('hidden', tab !== 'daily-tasks');
  document.getElementById('cold-email-view')?.classList.toggle('hidden', tab !== 'cold-email');
  document.getElementById('connections-view')?.classList.toggle('hidden', tab !== 'connections');
  document.getElementById('notes-panel')?.classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-panel')?.classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-panel')?.classList.toggle('hidden', tab !== 'expenses');
  document.getElementById('calendar-panel')?.classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('crm-panel')?.classList.toggle('hidden', tab !== 'crm');
  document.getElementById('dialer-panel')?.classList.toggle('hidden', tab !== 'dialer');
  document.getElementById('daily-tasks-panel')?.classList.toggle('hidden', tab !== 'daily-tasks');
  document.getElementById('cold-email-panel')?.classList.toggle('hidden', tab !== 'cold-email');
  if (tab === 'tasks' && boards.length && !currentBoardId) selectBoard(boards[0].id);
  if (tab === 'todo') loadEisenhowerDay();
  if (tab === 'trash') loadTrash();
  if (tab === 'archive') loadArchive();
  if (tab === 'expenses') loadExpenses();
  if (tab === 'calendar') loadCalendar();
  if (tab === 'crm') loadCrm();
  if (tab === 'dialer') loadDialerTab();
  if (tab === 'daily-tasks') loadDailyTasks();
  if (tab === 'cold-email') loadColdEmail();
  if (tab === 'connections') loadConnections();
  if (tab !== 'expenses') { selectedExpenses.clear(); lastClickedExpenseId = null; }
}

// ── To Do (Eisenhower matrix) ───────────────────────────────────
const EISENHOWER_QUADS = ['do', 'schedule', 'delegate', 'delete'];
let eisenhowerLoadedDate = null;
let eisenhowerSaveTimers = {};

function eisenhowerTodayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function eisenhowerFlashSaved() {
  const flag = document.getElementById('todo-saved-flag');
  if (!flag) return;
  flag.classList.add('show');
  clearTimeout(eisenhowerFlashSaved._t);
  eisenhowerFlashSaved._t = setTimeout(() => flag.classList.remove('show'), 1400);
}

function eisenhowerScheduleSave(quad) {
  clearTimeout(eisenhowerSaveTimers[quad]);
  eisenhowerSaveTimers[quad] = setTimeout(async () => {
    const date = eisenhowerLoadedDate;
    const body = {};
    EISENHOWER_QUADS.forEach(q => { body[q] = document.getElementById('todo-input-' + q).value; });
    try { await apiCall('PUT', '/eisenhower/' + date, body); eisenhowerFlashSaved(); } catch (e) {}
  }, 400);
}

async function loadEisenhowerDay(date) {
  const dateInput = document.getElementById('todo-date');
  if (!date) date = dateInput.value || eisenhowerTodayISO();
  dateInput.value = date;
  eisenhowerLoadedDate = date;
  const d = new Date(date + 'T00:00:00');
  document.getElementById('todo-dow').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  let data = {};
  try { data = await apiCall('GET', '/eisenhower/' + date); } catch (e) {}
  EISENHOWER_QUADS.forEach(q => { document.getElementById('todo-input-' + q).value = data[q] || ''; });
}

// ── Tags helpers ───────────────────────────────────────────────
function noteTags(note) {
  return (note && note.tags ? note.tags : '').split(',').map(t => t.trim()).filter(Boolean);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function tagColor(name) {
  const stored = JSON.parse(localStorage.getItem('tag-colors') || '{}');
  if (stored[name]) return stored[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 55, 55);
}

// Tags are a single shared namespace/color store across Notes and Projects
// (tasks) — a color or rename change refreshes both sides' UI.
function setTagColor(name, color) {
  const stored = JSON.parse(localStorage.getItem('tag-colors') || '{}');
  stored[name] = color;
  localStorage.setItem('tag-colors', JSON.stringify(stored));
  renderTagsBar(); renderNotesList(); renderTagEditor();
  renderTaskTagsBar(); renderKanban(); renderTaskTagEditor();
  renderDailyTaskCatBar(); renderDailyTasksList();
}

// One-time migration: task tags used to be a separate color namespace
// ('task-tag-colors'). Fold any saved colors into the shared store (note
// colors win on a name collision, since notes tags shipped first) and drop
// the old key — nothing reads it anymore now that tags are unified.
(() => {
  const old = localStorage.getItem('task-tag-colors');
  if (!old) return;
  try {
    const oldColors = JSON.parse(old);
    const merged = { ...oldColors, ...JSON.parse(localStorage.getItem('tag-colors') || '{}') };
    localStorage.setItem('tag-colors', JSON.stringify(merged));
  } catch (e) {}
  localStorage.removeItem('task-tag-colors');
})();

function renderTagsBar() {
  const bar = document.getElementById('tags-bar');
  if (!bar) return;
  const allTags = new Set();
  notes.forEach(n => { const f = notesFullCache[n.id] || n; noteTags(f).forEach(t => allTags.add(t)); });
  if (!allTags.size) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = [...allTags].sort().map(t => {
    const c = tagColor(t);
    return `<span class="tag-filter-pill${t === activeTag ? ' active' : ''}" data-tag="${escHtml(t)}" style="--tag-c:${c}">${escHtml(t)}</span>`;
  }).join('') + (activeTag ? `<span class="tag-filter-clear" id="tag-clear">✕</span>` : '');
  bar.querySelectorAll('.tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      activeTag = el.dataset.tag === activeTag ? null : el.dataset.tag;
      renderTagsBar(); renderNotesList();
    });
  });
  document.getElementById('tag-clear')?.addEventListener('click', () => {
    activeTag = null; renderTagsBar(); renderNotesList();
  });
}

// ── Notes list ─────────────────────────────────────────────────
function renderNotesList(q = '') {
  const search = (q || '').toLowerCase().trim();
  const list = document.getElementById('notes-list');
  let filtered = notes;
  if (activeTag) {
    filtered = filtered.filter(n => {
      const f = notesFullCache[n.id] || n;
      return noteTags(f).includes(activeTag);
    });
  }
  if (search) {
    filtered = filtered.filter(n => {
      if (n.title.toLowerCase().includes(search)) return true;
      const f = notesFullCache[n.id];
      return f && f.content && f.content.toLowerCase().includes(search);
    });
    searchNotesIDB(search);
  }
  list.innerHTML = filtered.map(n => {
    const f = notesFullCache[n.id] || n;
    const tags = noteTags(f);
    let snippet = '';
    if (search && f && f.content) {
      const idx = f.content.toLowerCase().indexOf(search);
      if (idx >= 0) snippet = '…' + f.content.slice(Math.max(0,idx-20), idx+50).replace(/\n/g,' ') + '…';
    }
    return `<div class="note-item${n.id===currentNoteId?' active':''}" draggable="true" data-id="${n.id}">
      <div class="note-item-title">${escHtml(n.title)}</div>
      ${snippet ? `<div class="note-item-snippet">${escHtml(snippet)}</div>` : `<div class="note-item-date">${fmtDate(n.updated_at)}</div>`}
      ${tags.length ? `<div class="note-item-tags">${tags.map(t=>`<span class="note-tag" style="--tag-c:${tagColor(t)}">${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('') || '<div style="padding:16px 12px;color:#444;font-size:12px;">No notes found</div>';
  list.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
    el.addEventListener('dragstart', e => {
      dragNoteId = el.dataset.id;
      e.dataTransfer.setData('note-drag', dragNoteId);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging', 'drop-above', 'drop-below'); dragNoteId = null; });
    el.addEventListener('dragover', e => {
      if (!Array.from(e.dataTransfer.types).includes('note-drag')) return;
      e.preventDefault();
      const mid = el.getBoundingClientRect().top + el.offsetHeight / 2;
      el.classList.toggle('drop-above', e.clientY < mid);
      el.classList.toggle('drop-below', e.clientY >= mid);
    });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-above', 'drop-below'); });
    el.addEventListener('drop', e => {
      if (!Array.from(e.dataTransfer.types).includes('note-drag')) return;
      e.preventDefault();
      const insertBefore = el.classList.contains('drop-above');
      el.classList.remove('drop-above', 'drop-below');
      const fromId = e.dataTransfer.getData('note-drag');
      if (!fromId || fromId === el.dataset.id) return;
      reorderNotes(fromId, el.dataset.id, insertBefore);
    });
  });
  renderNotesEmpty();
}

// When no note is open, fill the empty editor area with a card per note
// (all notes, most-recently-edited first) instead of leaving it blank.
function renderNotesEmpty() {
  if (currentNoteId) return; // editor owns the area
  const area = document.getElementById('note-editor-area');
  if (!area) return;
  if (!notes.length) {
    area.innerHTML = '<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;">Select or create a note</div>';
    return;
  }
  const sorted = [...notes].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  area.innerHTML = `<div class="notes-empty-grid">` + sorted.map(n => {
    const f = notesFullCache[n.id] || n;
    const tags = noteTags(f);
    let snippet = '';
    if (f.content) snippet = f.content.replace(/[#*`_>~]/g, '').replace(/\n+/g, ' ').trim().slice(0, 90);
    return `<div class="notes-empty-card" data-id="${n.id}">
      <div class="notes-empty-card-title">${escHtml(n.title || 'Untitled')}</div>
      ${snippet ? `<div class="notes-empty-card-snippet">${escHtml(snippet)}</div>` : ''}
      <div class="notes-empty-card-foot">
        <span class="notes-empty-card-date">${fmtDate(n.updated_at)}</span>
        ${tags.length ? `<div class="note-item-tags">${tags.map(t => `<span class="note-tag" style="--tag-c:${tagColor(t)}">${escHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('') + `</div>`;
  area.querySelectorAll('.notes-empty-card').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
  });
}

let searchDebTimer = null;
async function searchNotesIDB(q) {
  clearTimeout(searchDebTimer);
  searchDebTimer = setTimeout(async () => {
    const all = await idbGetAll('notes'); let changed = false;
    for (const n of all) { if (!notesFullCache[n.id] && n.content && n.content.toLowerCase().includes(q)) { notesFullCache[n.id] = n; changed = true; } }
    if (changed) renderNotesList();
  }, 150);
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}

// ── Trash ──────────────────────────────────────────────────────
function renderTrashView(data) {
  const content = document.getElementById('trash-content');
  if (!content) return;
  const notes = data.notes || [];
  const tasks = data.tasks || [];
  const trashedReminders = data.reminders || [];
  const emptyBtn = document.getElementById('empty-trash-btn');
  if (emptyBtn) emptyBtn.disabled = !notes.length && !tasks.length && !trashedReminders.length;
  if (!notes.length && !tasks.length && !trashedReminders.length) {
    content.innerHTML = '<div class="trash-empty">Trash is empty</div>';
    return;
  }
  let html = '';
  if (notes.length) {
    html += `<div class="trash-section-label">Notes</div>`;
    html += notes.map(n => `<div class="trash-item">
      <div class="trash-item-info">
        <span class="trash-item-title">${escHtml(n.title)}</span>
        <span class="trash-item-date">Deleted ${fmtDate(n.deleted_at)}</span>
      </div>
      <div class="trash-item-actions">
        <button class="trash-restore-btn" data-type="note" data-id="${n.id}">Restore</button>
        <button class="trash-perm-btn" data-type="note" data-id="${n.id}">Delete forever</button>
      </div>
    </div>`).join('');
  }
  if (tasks.length) {
    html += `<div class="trash-section-label">Projects</div>`;
    html += tasks.map(t => `<div class="trash-item">
      <div class="trash-item-info">
        <span class="trash-item-title">${escHtml(t.title)}</span>
        <span class="trash-item-date">Deleted ${fmtDate(t.deleted_at)}</span>
      </div>
      <div class="trash-item-actions">
        <button class="trash-restore-btn" data-type="task" data-id="${t.id}">Restore</button>
        <button class="trash-perm-btn" data-type="task" data-id="${t.id}">Delete forever</button>
      </div>
    </div>`).join('');
  }
  if (trashedReminders.length) {
    html += `<div class="trash-section-label">Reminders</div>`;
    html += trashedReminders.map(r => `<div class="trash-item">
      <div class="trash-item-info">
        <span class="trash-item-title">${escHtml(r.title)}</span>
        <span class="trash-item-date">Deleted ${fmtDate(r.deleted_at)}</span>
      </div>
      <div class="trash-item-actions">
        <button class="trash-restore-btn" data-type="reminder" data-id="${r.id}">Restore</button>
        <button class="trash-perm-btn" data-type="reminder" data-id="${r.id}">Delete forever</button>
      </div>
    </div>`).join('');
  }
  content.innerHTML = html;
  content.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiCall('POST', '/trash/restore', { type: btn.dataset.type, id: btn.dataset.id });
        await fullSync(); loadTrash(); toast('Restored');
      } catch(e) { toast('Could not restore — check connection'); }
    });
  });
  content.querySelectorAll('.trash-perm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete? This cannot be undone.')) return;
      try {
        await apiCall('DELETE', '/trash/item', { type: btn.dataset.type, id: btn.dataset.id });
        loadTrash(); toast('Permanently deleted');
      } catch(e) { toast('Could not delete — check connection'); }
    });
  });
}

async function loadTrash() {
  const content = document.getElementById('trash-content');
  if (content) content.innerHTML = '<div class="trash-empty">Loading…</div>';
  try {
    const data = await apiFetch('GET', '/trash');
    renderTrashView(data);
  } catch(e) {
    if (content) content.innerHTML = '<div class="trash-empty">Could not load trash — check connection</div>';
  }
}

// ── Archive ────────────────────────────────────────────────────
function renderArchiveView(data) {
  const content = document.getElementById('archive-content');
  if (!content) return;
  const notes = data.notes || [];
  const tasks = data.tasks || [];
  const reminders = data.reminders || [];
  const boards = data.boards || [];
  if (!notes.length && !tasks.length && !reminders.length && !boards.length) {
    content.innerHTML = '<div class="trash-empty">Archive is empty</div>';
    return;
  }
  const section = (label, type, items, nameKey) => !items.length ? '' :
    `<div class="trash-section-label">${label}</div>` +
    items.map(it => `<div class="trash-item">
      <div class="trash-item-info">
        <span class="trash-item-title">${escHtml(it[nameKey])}</span>
        <span class="trash-item-date">Archived ${fmtDate(it.archived_at)}</span>
      </div>
      <div class="trash-item-actions">
        <button class="trash-restore-btn" data-type="${type}" data-id="${it.id}">Restore</button>
        <button class="trash-perm-btn" data-type="${type}" data-id="${it.id}">Delete forever</button>
      </div>
    </div>`).join('');
  content.innerHTML =
    section('Notes', 'note', notes, 'title') +
    section('Projects', 'task', tasks, 'title') +
    section('Reminders', 'reminder', reminders, 'title') +
    section('Boards', 'board', boards, 'name');
  content.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await apiCall('POST', '/archive/restore', { type: btn.dataset.type, id: btn.dataset.id });
        await fullSync(); loadArchive(); toast('Restored');
      } catch(e) { toast('Could not restore — check connection'); }
    });
  });
  content.querySelectorAll('.trash-perm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const msg = btn.dataset.type === 'board'
        ? 'Permanently delete this board and all its data? This cannot be undone.'
        : 'Delete forever? This moves it to Trash for final cleanup.';
      if (!confirm(msg)) return;
      try {
        await apiCall('POST', '/archive/delete', { type: btn.dataset.type, id: btn.dataset.id });
        loadArchive(); toast(btn.dataset.type === 'board' ? 'Board deleted' : 'Moved to Trash');
      } catch(e) { toast('Could not delete — check connection'); }
    });
  });
}

async function loadArchive() {
  const content = document.getElementById('archive-content');
  if (content) content.innerHTML = '<div class="trash-empty">Loading…</div>';
  try {
    const data = await apiFetch('GET', '/archive');
    renderArchiveView(data);
  } catch(e) {
    if (content) content.innerHTML = '<div class="trash-empty">Could not load archive — check connection</div>';
  }
}

// ── Date picker ────────────────────────────────────────────────
const DP_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DP_DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];
let dpYear = new Date().getFullYear();
let dpMonth = new Date().getMonth();

function dpToIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function dpFromIso(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y,m,d] = s.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  return isNaN(dt.getTime()) ? null : dt;
}
function isoToMdy(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
  const [y, m, d] = s.split('-');
  return `${m}/${d}/${y}`;
}
function mdyToIso(s) {
  if (!s || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return '';
  const [m, d, y] = s.split('/');
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function dpFromMdy(s) {
  if (!s) return null;
  const iso = mdyToIso(s);
  return dpFromIso(iso);
}

// One picker implementation drives every date field; dpTarget says which
// input/calendar pair is active (only one calendar is ever open at a time —
// the document-level close listener guarantees that).
let dpTarget = { inputId: 'exp-date', calId: 'exp-date-cal' };

function dpInit(iso, inputId = 'exp-date', calId = 'exp-date-cal') {
  dpTarget = { inputId, calId };
  const d = dpFromIso(iso) || new Date();
  dpYear = d.getFullYear(); dpMonth = d.getMonth();
  document.getElementById(calId)?.classList.add('hidden');
}

function dpRender() {
  const cal = document.getElementById(dpTarget.calId);
  const input = document.getElementById(dpTarget.inputId);
  if (!cal || !input) return;
  const today = dpToIso(new Date());
  const sel = mdyToIso(input.value);
  const first = new Date(dpYear, dpMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(dpYear, dpMonth+1, 0).getDate();
  let cells = [];
  for (let i = 0; i < startDow; i++) {
    const d = new Date(dpYear, dpMonth, 1 - (startDow - i));
    cells.push({ iso: dpToIso(d), label: d.getDate(), out: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(dpYear, dpMonth, d);
    cells.push({ iso: dpToIso(dt), label: d, out: false });
  }
  const rem = 7 - (cells.length % 7);
  if (rem < 7) for (let d = 1; d <= rem; d++) {
    const dt = new Date(dpYear, dpMonth+1, d);
    cells.push({ iso: dpToIso(dt), label: d, out: true });
  }
  cal.innerHTML = `
    <div class="dp-header">
      <button class="dp-nav" id="dp-prev" type="button">‹</button>
      <span class="dp-month-label">${DP_MONTHS[dpMonth]} ${dpYear}</span>
      <button class="dp-nav" id="dp-next" type="button">›</button>
    </div>
    <div class="dp-grid">
      ${DP_DAYS.map(d => `<span class="dp-dow">${d}</span>`).join('')}
      ${cells.map(c => `<button type="button" class="dp-day${c.out?' dp-out':''}${c.iso===today?' dp-today':''}${c.iso===sel?' dp-sel':''}" data-iso="${c.iso}">${c.label}</button>`).join('')}
    </div>
  `;
  cal.querySelector('#dp-prev').addEventListener('click', e => {
    e.stopPropagation();
    dpMonth--; if (dpMonth < 0) { dpMonth = 11; dpYear--; } dpRender();
  });
  cal.querySelector('#dp-next').addEventListener('click', e => {
    e.stopPropagation();
    dpMonth++; if (dpMonth > 11) { dpMonth = 0; dpYear++; } dpRender();
  });
  cal.querySelectorAll('.dp-day').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (input) input.value = isoToMdy(btn.dataset.iso);
      cal.classList.add('hidden');
    });
  });
}

// .dp-cal is position:fixed (escapes ancestor overflow:hidden — see app.css),
// so its screen position has to be computed against the viewport instead of
// relying on CSS anchoring. Clamped so it never runs off any edge.
function dpPosition(wrapEl, cal) {
  const r = wrapEl.getBoundingClientRect();
  const margin = 8;
  let top = r.bottom + 4;
  let left = r.left;
  const calW = cal.offsetWidth || 244;
  const calH = cal.offsetHeight || 260;
  if (top + calH > window.innerHeight - margin) top = r.top - calH - 4; // flip above if no room below
  if (top < margin) top = margin;
  if (left + calW > window.innerWidth - margin) left = window.innerWidth - calW - margin;
  if (left < margin) left = margin;
  cal.style.top = top + 'px';
  cal.style.left = left + 'px';
}

function wireDatePicker(inputId, calId, triggerId) {
  document.getElementById(triggerId)?.addEventListener('click', e => {
    e.stopPropagation();
    const cal = document.getElementById(calId);
    const wrap = document.getElementById(inputId)?.closest('.dp-wrap');
    if (!cal) return;
    if (cal.classList.contains('hidden')) {
      dpTarget = { inputId, calId };
      const typed = dpFromMdy(document.getElementById(inputId)?.value);
      if (typed) { dpYear = typed.getFullYear(); dpMonth = typed.getMonth(); }
      dpRender(); cal.classList.remove('hidden');
      if (wrap) dpPosition(wrap, cal);
    } else cal.classList.add('hidden');
  });
}
wireDatePicker('exp-date', 'exp-date-cal', 'exp-date-trigger');
wireDatePicker('rem-date', 'rem-date-cal', 'rem-date-trigger');
document.addEventListener('click', () => {
  document.getElementById('exp-date-cal')?.classList.add('hidden');
  document.getElementById('rem-date-cal')?.classList.add('hidden');
});

// ── Expenses ───────────────────────────────────────────────────
async function loadExpenses() {
  try {
    [expenses, expenseCategories] = await Promise.all([
      apiFetch('GET', '/expenses'),
      apiFetch('GET', '/expense-categories'),
    ]);
  } catch(e) {}
  renderExpensesCatBar();
  renderExpensesList();
  renderExpenseCatsList();
}

function renderExpensesCatBar() {
  const bar = document.getElementById('expense-cat-bar');
  const label = document.getElementById('expense-cat-bar-label');
  if (!bar) return;
  const cats = [...new Set(expenses.map(e => e.category).filter(Boolean))].sort();
  if (!cats.length) { bar.innerHTML = ''; bar.style.display = 'none'; if (label) label.style.display = 'none'; return; }
  bar.style.display = '';
  if (label) label.style.display = '';
  bar.innerHTML =
    `<span class="tag-filter-pill${!activeExpenseCat ? ' active' : ''}" data-cat="" style="--tag-c:#5fc83b">All</span>` +
    cats.map(c =>
      `<span class="tag-filter-pill${c === activeExpenseCat ? ' active' : ''}" data-cat="${escHtml(c)}" style="--tag-c:#5fc83b">${escHtml(c)}</span>`
    ).join('');
  bar.querySelectorAll('.tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      activeExpenseCat = el.dataset.cat || null;
      renderExpensesCatBar(); renderExpensesList();
    });
  });
}

function fmtAmount(a) {
  return '$' + Number(a).toFixed(2);
}

const EXPENSE_COL_DEFS = {
  date:      { label: 'Date',      width: '88px' },
  category:  { label: 'Category',  width: '110px' },
  payee:     { label: 'Payee',     width: '1fr' },
  note:      { label: 'Note',      width: '1fr' },
  source:    { label: 'Source',    width: '72px' },
  frequency: { label: 'Frequency', width: '90px' },
  direction: { label: 'Type',      width: '100px' },
  amount:    { label: 'Amount',    width: '80px' },
};
const EXPENSE_COL_DEFAULT = ['date','category','payee','note','source','frequency','direction','amount'];
let expenseColOrder = (() => {
  try {
    const s = localStorage.getItem('expense-col-order');
    if (!s) return [...EXPENSE_COL_DEFAULT];
    const saved = JSON.parse(s);
    for (const col of EXPENSE_COL_DEFAULT) {
      if (!saved.includes(col)) {
        const amtIdx = saved.indexOf('amount');
        saved.splice(amtIdx === -1 ? saved.length : amtIdx, 0, col);
      }
    }
    return saved;
  } catch(e) { return [...EXPENSE_COL_DEFAULT]; }
})();
let expenseColWidths = (() => {
  try { return JSON.parse(localStorage.getItem('expense-col-widths') || '{}'); } catch(e) { return {}; }
})();
let expenseDragCol = null;

const COL_CELL_CLASS = {
  date: 'expense-entry-date', category: 'expense-entry-cat', payee: 'expense-entry-payee',
  note: 'expense-entry-note', source: 'expense-entry-source', frequency: 'expense-entry-frequency',
  direction: 'expense-entry-direction', amount: 'expense-entry-amount',
};

function getColWidth(key) {
  return expenseColWidths[key] != null ? `${expenseColWidths[key]}px` : EXPENSE_COL_DEFS[key].width;
}

function updateExpenseGrid() {
  const area = document.getElementById('expenses-list-area');
  if (!area) return;
  area.style.setProperty('--exp-grid', expenseColOrder.map(k => getColWidth(k)).join(' '));
}

function expenseEntryCell(e, key) {
  switch(key) {
    case 'date':     return `<span class="expense-entry-date">${escHtml(isoToMdy(e.date))}</span>`;
    case 'category': return `<span class="expense-entry-cat">${e.category ? escHtml(e.category) : ''}</span>`;
    case 'payee':    return `<span class="expense-entry-payee">${escHtml(e.payee || '—')}${e.pass_through ? ' <span class=\"exp-pass-through-badge\" title=\"Pass-through — excluded from surplus/deficit\">↔ pass-through</span>' : ''}</span>`;
    case 'note':     return `<span class="expense-entry-note">${escHtml(e.note || '')}</span>`;
    case 'source': {
      const srcClass = e.source === 'Chase Debit' ? ' src-chase-debit' : e.source === 'Chase Credit' ? ' src-chase-credit' : '';
      return `<span class="expense-entry-source${srcClass}">${escHtml(e.source || '')}</span>`;
    }
    case 'frequency': return `<span class="expense-entry-frequency">${escHtml(e.frequency || '')}</span>`;
    case 'direction': {
      const isDeposit = e.direction === 'deposit';
      return `<span class="expense-entry-direction ${isDeposit ? 'is-deposit' : 'is-withdrawal'}">${isDeposit ? '↑ Deposit' : '↓ Withdrawal'}</span>`;
    }
    case 'amount':    return `<span class="expense-entry-amount">${escHtml(fmtAmount(e.amount))}</span>`;
    default: return '';
  }
}

// ── Spending-over-time chart ────────────────────────────────────
// Money In (Debit) is the only income line — Credit "deposits" are refunds,
// not income, and pass-through rows (IHSS) are never real spend or income.
const EXPENSE_CHART_SOURCES = [
  { key: 'Chase Debit',      color: '#4a90e0', match: e => e.source === 'Chase Debit'  && e.direction !== 'deposit' },
  { key: 'Chase Credit',     color: '#ffffff', match: e => e.source === 'Chase Credit' && e.direction !== 'deposit' },
  { key: 'Money In (Debit)', color: '#b8862e', match: e => e.source === 'Chase Debit'  && e.direction === 'deposit' },
];
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// "Jul '24", never "Jul 24" — the latter reads as a day-of-month, not a year.
function fmtMonthYear(mk) {
  const [y, m] = mk.split('-');
  return `${MONTH_ABBR[Number(m) - 1]} '${y.slice(2)}`;
}
const expenseChartHiddenSeries = new Set();

function monthsBetween(minKey, maxKey) {
  const months = [];
  let [y, m] = minKey.split('-').map(Number);
  const [ey, em] = maxKey.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}

function niceCeil(v) {
  const mag = Math.pow(10, Math.floor(Math.log10(v || 1)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function fmtCompact(v) {
  if (v >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K';
  return '$' + Math.round(v);
}

function computeExpenseChartData(filtered) {
  const bySource = {};
  for (const e of filtered) {
    if (!e.date || e.pass_through) continue;
    const s = EXPENSE_CHART_SOURCES.find(s => s.match(e));
    if (!s) continue;
    (bySource[s.key] ??= {})[e.date.slice(0, 7)] = (bySource[s.key]?.[e.date.slice(0, 7)] || 0) + e.amount;
  }
  const allSeries = EXPENSE_CHART_SOURCES.filter(s => bySource[s.key]);
  if (!allSeries.length) return null;
  const visibleSeries = allSeries.filter(s => !expenseChartHiddenSeries.has(s.key));

  const allKeys = allSeries.flatMap(s => Object.keys(bySource[s.key]));
  const minKey = allKeys.reduce((a, b) => a < b ? a : b);
  const maxKey = allKeys.reduce((a, b) => a > b ? a : b);
  const months = monthsBetween(minKey, maxKey);

  let maxVal = 0;
  for (const s of visibleSeries) for (const mk of months) maxVal = Math.max(maxVal, bySource[s.key][mk] || 0);
  const niceMax = niceCeil(maxVal || 1);

  const W = 900, H = 260, padL = 56, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xFor = i => padL + (months.length > 1 ? (i / (months.length - 1)) * plotW : plotW / 2);
  const yFor = v => padT + plotH - (v / niceMax) * plotH;

  return { bySource, allSeries, visibleSeries, months, niceMax, W, H, padL, padR, padT, padB, plotW, plotH, xFor, yFor };
}

function expenseChartHtml(filtered) {
  const d = computeExpenseChartData(filtered);
  if (!d) return '<div class="expense-chart-empty">No Chase Debit/Credit data in this period.</div>';
  const { bySource, allSeries, visibleSeries, months, niceMax, W, H, padL, padR, padT, padB, plotW, xFor, yFor } = d;

  const legend = allSeries.map(s => {
    const hidden = expenseChartHiddenSeries.has(s.key);
    return `<span class="exp-chart-legend-item${hidden ? ' hidden-series' : ''}" data-source="${escHtml(s.key)}" title="Click to ${hidden ? 'show' : 'isolate/hide'}"><span class="exp-chart-legend-swatch" style="background:${s.color}"></span>${escHtml(s.key)}</span>`;
  }).join('');

  // A single month has no "over time" to plot — a line chart of one point is just
  // two dots on empty axes. Show the totals as stat tiles instead.
  if (months.length < 2) {
    const mk = months[0];
    const stats = visibleSeries.map(s => `
      <div class="exp-chart-stat">
        <span class="exp-chart-stat-val">${escHtml(fmtAmount(bySource[s.key][mk] || 0))}</span>
        <span class="exp-chart-stat-label"><span class="exp-chart-stat-swatch" style="background:${s.color}"></span>${escHtml(s.key)}</span>
      </div>`).join('');
    return `
      <div class="expense-chart-wrap">
        <div class="exp-chart-stats">${stats || '<span class="expense-chart-empty">All lines hidden.</span>'}</div>
      </div>`;
  }

  let gridLines = '', yLabels = '';
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const val = niceMax * i / gridSteps;
    const y = yFor(val);
    gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="exp-chart-grid"/>`;
    yLabels += `<text x="${padL - 8}" y="${y + 4}" class="exp-chart-axis-label" text-anchor="end">${fmtCompact(val)}</text>`;
  }

  let xLabels = '';
  const labelStep = months.length > 8 ? 3 : 1;
  months.forEach((mk, i) => {
    if (i % labelStep !== 0 && i !== months.length - 1) return;
    const isJan = mk.endsWith('-01');
    xLabels += `<text x="${xFor(i)}" y="${H - 8}" class="exp-chart-axis-label${isJan ? ' exp-chart-axis-label-year' : ''}" text-anchor="middle">${fmtMonthYear(mk)}</text>`;
  });

  let paths = '';
  visibleSeries.forEach(s => {
    const pts = months.map((mk, i) => `${xFor(i)},${yFor(bySource[s.key][mk] || 0)}`).join(' ');
    const lastI = months.length - 1;
    paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    paths += `<circle cx="${xFor(lastI)}" cy="${yFor(bySource[s.key][months[lastI]] || 0)}" r="5" fill="${s.color}" stroke="#161616" stroke-width="2"/>`;
  });

  return `
    <div class="expense-chart-wrap">
      <div class="exp-chart-legend">${legend}</div>
      <svg class="exp-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${gridLines}${yLabels}${xLabels}${paths}
        <rect class="exp-chart-hit" x="${padL}" y="${padT}" width="${plotW}" height="${H - padT - padB}" fill="transparent"/>
        <line class="exp-chart-crosshair hidden" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>
      </svg>
      <div class="exp-chart-tooltip hidden"></div>
    </div>`;
}

function wireExpenseChart(area, filtered) {
  const wrap = area.querySelector('.expense-chart-wrap');
  if (!wrap) return;
  const d = computeExpenseChartData(filtered);
  if (!d) return;
  const { bySource, visibleSeries, months, xFor } = d;

  wrap.querySelectorAll('.exp-chart-legend-item').forEach(el => {
    el.addEventListener('click', () => {
      const src = el.dataset.source;
      if (expenseChartHiddenSeries.has(src)) expenseChartHiddenSeries.delete(src);
      else expenseChartHiddenSeries.add(src);
      renderExpensesList();
    });
  });

  const svg = wrap.querySelector('.exp-chart-svg');
  if (!svg) return; // single-month stat-tile view has no crosshair/tooltip to wire
  const hit = wrap.querySelector('.exp-chart-hit');
  const crosshair = wrap.querySelector('.exp-chart-crosshair');
  const tooltip = wrap.querySelector('.exp-chart-tooltip');

  const nearestIdx = clientX => {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = 0;
    const svgX = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    let best = 0, bestDist = Infinity;
    months.forEach((mk, i) => { const dist = Math.abs(xFor(i) - svgX); if (dist < bestDist) { bestDist = dist; best = i; } });
    return best;
  };

  hit.addEventListener('pointermove', e => {
    const i = nearestIdx(e.clientX);
    const mk = months[i];
    const x = xFor(i);
    crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
    crosshair.classList.remove('hidden');
    const rows = visibleSeries.map(s =>
      `<div class="exp-chart-tooltip-row"><span class="exp-chart-tooltip-key" style="background:${s.color}"></span><span class="exp-chart-tooltip-val">${fmtAmount(bySource[s.key][mk] || 0)}</span><span class="exp-chart-tooltip-name">${escHtml(s.key)}</span></div>`
    ).join('');
    tooltip.innerHTML = `<div class="exp-chart-tooltip-month">${escHtml(fmtMonthYear(mk))}</div>${rows}`;
    tooltip.classList.remove('hidden');
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const px = svgRect.left - wrapRect.left + (x / d.W) * svgRect.width;
    tooltip.style.left = Math.min(px, wrapRect.width - 160) + 'px';
  });
  hit.addEventListener('pointerleave', () => {
    crosshair.classList.add('hidden');
    tooltip.classList.add('hidden');
  });
}

function expenseTimeFilterHtml() {
  const years = [...new Set(expenses.map(e => e.date?.slice(0, 4)).filter(Boolean))].sort();
  const monthOpts = MONTH_ABBR.map((name, i) => {
    const v = String(i + 1).padStart(2, '0');
    return `<option value="${v}" ${expenseFilterMonth === v ? 'selected' : ''}>${name}</option>`;
  }).join('');
  const yearOpts = years.map(y => `<option value="${y}" ${expenseFilterYear === y ? 'selected' : ''}>${y}</option>`).join('');
  const hasFilter = expenseFilterYear !== 'all' || expenseFilterMonth !== 'all';
  return `
    <div class="expense-time-filter">
      <span class="expense-time-filter-label">Period</span>
      <select id="expense-year-select" class="expense-time-select">
        <option value="all" ${expenseFilterYear === 'all' ? 'selected' : ''}>All years</option>
        ${yearOpts}
      </select>
      <select id="expense-month-select" class="expense-time-select" ${expenseFilterYear === 'all' ? 'disabled' : ''}>
        <option value="all" ${expenseFilterMonth === 'all' ? 'selected' : ''}>All months</option>
        ${monthOpts}
      </select>
      ${hasFilter ? '<button id="expense-time-clear-btn" class="expense-time-clear-btn" title="Reset the Year/Month filter back to All — does not delete anything">Clear period filter</button>' : ''}
    </div>`;
}

const EXPENSE_SOURCE_FILTERS = [
  { key: 'all', label: 'All', color: '#5fc83b' },
  { key: 'Chase Debit', label: 'Chase Debit', color: '#4a90e0' },
  { key: 'Chase Credit', label: 'Chase Credit', color: '#ffffff' },
];
function expenseSourceFilterHtml() {
  return `<div class="expense-source-filter">${EXPENSE_SOURCE_FILTERS.map(s =>
    `<span class="tag-filter-pill${expenseFilterSource === s.key ? ' active' : ''}" data-source="${escHtml(s.key)}" style="--tag-c:${s.color}">${escHtml(s.label)}</span>`
  ).join('')}</div>`;
}

function expensePayeeSearchHtml() {
  return `<div class="expense-payee-search">
    <input type="text" id="expense-payee-search-input" placeholder="Search payee… (e.g. Anthropic, OpenAI, Perplexity)" value="${escHtml(expenseSearchQuery)}" autocomplete="off">
    ${expenseSearchQuery ? '<button id="expense-payee-search-clear" title="Clear search">✕</button>' : ''}
  </div>`;
}

// ── Cash flow (surplus/deficit) ─────────────────────────────────
// Chase Debit only — that's the account holding real cash. Credit purchases
// aren't a cash event until paid off, which already shows as a Debit outflow.
function computeDebitCashFlow(list) {
  let moneyIn = 0, moneyOut = 0;
  for (const e of list) {
    if (e.source !== 'Chase Debit' || e.pass_through) continue;
    if (e.direction === 'deposit') moneyIn += e.amount;
    else moneyOut += e.amount;
  }
  return { moneyIn, moneyOut, net: moneyIn - moneyOut };
}

function cashFlowHtml(list) {
  const { moneyIn, moneyOut } = computeDebitCashFlow(list);
  if (!moneyIn && !moneyOut) return '';
  return `
    <div class="exp-cashflow">
      <div class="exp-cashflow-sub">
        <span class="exp-cashflow-in">↑ ${fmtAmount(moneyIn)} in</span>
        <span class="exp-cashflow-out">↓ ${fmtAmount(moneyOut)} out</span>
        <span class="exp-cashflow-label">Chase Debit only — checking account cash flow (net shown above)</span>
      </div>
    </div>`;
}

// ── Spending-by-category breakdown ──────────────────────────────
function computeCategoryBreakdown(list) {
  const totals = {};
  let grand = 0;
  for (const e of list) {
    if (e.direction === 'deposit' || e.pass_through) continue;
    const cat = e.category || 'Uncategorized';
    totals[cat] = (totals[cat] || 0) + Math.abs(e.amount);
    grand += Math.abs(e.amount);
  }
  const rows = Object.entries(totals).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  return { rows, grand };
}

function categoryBreakdownHtml(list) {
  const { rows, grand } = computeCategoryBreakdown(list);
  if (!rows.length) return '<div class="expense-chart-empty">No spending in this period.</div>';
  const max = rows[0].total;
  return `
    <div class="exp-cat-chart">
      ${rows.map(r => { const uncat = r.category === 'Uncategorized'; return `
        <div class="exp-cat-row${uncat ? ' exp-cat-uncat' : ''}" data-cat="${escHtml(r.category)}" ${uncat ? '' : `title="Click to filter the list to ${escHtml(r.category)}"`}>
          <span class="exp-cat-label">${escHtml(r.category)}</span>
          <span class="exp-cat-track"><span class="exp-cat-fill" style="width:${max ? (r.total / max * 100) : 0}%"></span></span>
          <span class="exp-cat-val">${escHtml(fmtAmount(r.total))}</span>
          <span class="exp-cat-pct">${grand ? Math.round(r.total / grand * 100) : 0}%</span>
        </div>`; }).join('')}
    </div>`;
}

function renderExpensesList() {
  const area = document.getElementById('expenses-list-area');
  if (!area) return;
  let periodSourceFiltered = expenses;
  if (expenseFilterSource !== 'all') periodSourceFiltered = periodSourceFiltered.filter(e => e.source === expenseFilterSource);
  if (expenseFilterYear !== 'all') periodSourceFiltered = periodSourceFiltered.filter(e => e.date?.slice(0, 4) === expenseFilterYear);
  if (expenseFilterMonth !== 'all') periodSourceFiltered = periodSourceFiltered.filter(e => e.date?.slice(5, 7) === expenseFilterMonth);
  if (expenseSearchQuery.trim()) {
    const q = expenseSearchQuery.trim().toLowerCase();
    periodSourceFiltered = periodSourceFiltered.filter(e => (e.payee || '').toLowerCase().includes(q));
  }
  let filtered = activeExpenseCat ? periodSourceFiltered.filter(e => e.category === activeExpenseCat) : periodSourceFiltered;

  filtered = [...filtered].sort((a, b) => {
    for (const key of expenseColOrder) {
      const s = expenseSortCols.find(x => x.col === key);
      if (!s) continue;
      let av = a[key] ?? '', bv = b[key] ?? '';
      if (key === 'amount') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return s.dir === 'asc' ? -1 : 1;
      if (av > bv) return s.dir === 'asc' ? 1 : -1;
    }
    return 0;
  });

  const allFilteredIds = filtered.map(e => e.id);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selectedExpenses.has(id));
  const anySelected = selectedExpenses.size > 0;

  const headerRow = `<div class="expense-header-row">
    <input type="checkbox" class="exp-select-all" ${allSelected ? 'checked' : ''} ${anySelected && !allSelected ? 'data-indeterminate="1"' : ''} title="Select all">
    ${expenseColOrder.map(key => {
      const sortEntry = expenseSortCols.find(s => s.col === key);
      const isActive = !!sortEntry;
      const badge = sortEntry ? (sortEntry.dir === 'asc' ? '↑' : '↓') : '';
      return `<span class="exp-hdr${isActive ? ' active' : ''}" data-col="${key}" draggable="true">${EXPENSE_COL_DEFS[key].label}${badge ? ` <span class="sort-arrow">${badge}</span>` : ''}<span class="exp-col-resize" data-col="${key}"></span></span>`;
    }).join('')}
  </div>`;

  const { net: compactNet } = computeDebitCashFlow(periodSourceFiltered);
  const compactNetHtml = compactNet ? `<span class="expense-list-net ${compactNet >= 0 ? 'is-surplus' : 'is-deficit'}">${compactNet >= 0 ? '+' : '−'}${escHtml(fmtAmount(Math.abs(compactNet)))}</span>` : '';

  area.innerHTML = `
    <div class="exp-sticky-header">
      <div class="exp-bulk-bar${anySelected ? '' : ' hidden'}">
        <span class="exp-bulk-count">${selectedExpenses.size} selected</span>
        <button class="exp-bulk-delete">Delete selected</button>
        <button class="exp-bulk-clear">Clear</button>
      </div>
      <div class="expense-list-header">
        <span class="expense-list-left">
          <span class="expense-list-label">${activeExpenseCat ? escHtml(activeExpenseCat) : 'All expenses'}</span>
          ${compactNetHtml}
        </span>
        <span class="expense-list-header-right">
          <button class="expense-chart-toggle-btn" id="expense-chart-toggle-btn">${expenseChartVisible ? '📈 Hide chart' : '📈 Chart'}</button>
          <button class="expense-add-btn" id="expense-add-inline-btn">+ Add expense</button>
        </span>
      </div>
      ${expenseSourceFilterHtml()}
      ${expensePayeeSearchHtml()}
      ${expenseTimeFilterHtml()}
    </div>
    ${expenseChartVisible ? cashFlowHtml(periodSourceFiltered) + expenseChartHtml(filtered) + categoryBreakdownHtml(periodSourceFiltered) : ''}
    ${filtered.length ? headerRow : ''}
    ${filtered.length ? `
      <div class="expense-entries">
        ${filtered.map(e => `
          <div class="expense-entry${selectedExpenses.has(e.id) ? ' exp-selected' : ''}" data-id="${e.id}">
            <input type="checkbox" class="exp-row-check" data-id="${e.id}" ${selectedExpenses.has(e.id) ? 'checked' : ''}>
            ${expenseColOrder.map(key => expenseEntryCell(e, key)).join('')}
            <button class="expense-entry-del" data-id="${e.id}" title="Delete">✕</button>
          </div>
        `).join('')}
      </div>` : `<div class="expense-list-empty">No expenses yet.</div>`}
  `;

  updateExpenseGrid();
  if (expenseChartVisible) wireExpenseChart(area, filtered);

  const chartToggleBtn = area.querySelector('#expense-chart-toggle-btn');
  if (chartToggleBtn) chartToggleBtn.addEventListener('click', () => {
    expenseChartVisible = !expenseChartVisible;
    localStorage.setItem('expense-chart-visible', expenseChartVisible ? '1' : '0');
    renderExpensesList();
  });

  area.querySelectorAll('.expense-source-filter .tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      expenseFilterSource = el.dataset.source;
      localStorage.setItem('expense-filter-source', expenseFilterSource);
      renderExpensesList();
    });
  });
  area.querySelectorAll('.exp-cat-row:not(.exp-cat-uncat)').forEach(el => {
    el.addEventListener('click', () => {
      activeExpenseCat = el.dataset.cat;
      renderExpensesCatBar(); renderExpensesList();
    });
  });

  const payeeSearchInput = area.querySelector('#expense-payee-search-input');
  if (payeeSearchInput) payeeSearchInput.addEventListener('input', () => {
    expenseSearchQuery = payeeSearchInput.value;
    localStorage.setItem('expense-search', expenseSearchQuery);
    renderExpensesList();
    const newInput = document.getElementById('expense-payee-search-input');
    if (newInput) { newInput.focus(); newInput.setSelectionRange(newInput.value.length, newInput.value.length); }
  });
  const payeeSearchClear = area.querySelector('#expense-payee-search-clear');
  if (payeeSearchClear) payeeSearchClear.addEventListener('click', () => {
    expenseSearchQuery = '';
    localStorage.setItem('expense-search', '');
    renderExpensesList();
  });

  const yearSel = area.querySelector('#expense-year-select');
  if (yearSel) yearSel.addEventListener('change', () => {
    expenseFilterYear = yearSel.value;
    if (expenseFilterYear === 'all') expenseFilterMonth = 'all';
    localStorage.setItem('expense-filter-year', expenseFilterYear);
    localStorage.setItem('expense-filter-month', expenseFilterMonth);
    renderExpensesList();
  });
  const monthSel = area.querySelector('#expense-month-select');
  if (monthSel) monthSel.addEventListener('change', () => {
    expenseFilterMonth = monthSel.value;
    localStorage.setItem('expense-filter-month', expenseFilterMonth);
    renderExpensesList();
  });
  const timeClearBtn = area.querySelector('#expense-time-clear-btn');
  if (timeClearBtn) timeClearBtn.addEventListener('click', () => {
    expenseFilterYear = 'all'; expenseFilterMonth = 'all';
    localStorage.setItem('expense-filter-year', 'all');
    localStorage.setItem('expense-filter-month', 'all');
    renderExpensesList();
  });

  // Select-all checkbox
  const selectAllCb = area.querySelector('.exp-select-all');
  if (selectAllCb) {
    selectAllCb.indeterminate = anySelected && !allSelected;
    selectAllCb.addEventListener('change', () => {
      if (selectAllCb.checked) allFilteredIds.forEach(id => selectedExpenses.add(id));
      else allFilteredIds.forEach(id => selectedExpenses.delete(id));
      renderExpensesList();
    });
  }

  // Per-row checkboxes
  area.querySelectorAll('.exp-row-check').forEach((cb, idx) => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (e.shiftKey && lastClickedExpenseId) {
        const lastIdx = filtered.findIndex(x => x.id === lastClickedExpenseId);
        if (lastIdx !== -1) {
          const lo = Math.min(idx, lastIdx), hi = Math.max(idx, lastIdx);
          for (let i = lo; i <= hi; i++) selectedExpenses.add(filtered[i].id);
          lastClickedExpenseId = id;
          renderExpensesList();
          return;
        }
      }
      lastClickedExpenseId = id;
      if (cb.checked) selectedExpenses.add(id);
      else selectedExpenses.delete(id);
      renderExpensesList();
    });
  });

  // Row click — open modal when nothing selected, toggle selection otherwise; shift-click range-selects
  area.querySelectorAll('.expense-entry').forEach((el, idx) => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('exp-row-check') || e.target.classList.contains('expense-entry-del')) return;
      const id = el.dataset.id;
      if (e.shiftKey && lastClickedExpenseId) {
        const lastIdx = filtered.findIndex(x => x.id === lastClickedExpenseId);
        if (lastIdx !== -1) {
          const lo = Math.min(idx, lastIdx), hi = Math.max(idx, lastIdx);
          for (let i = lo; i <= hi; i++) selectedExpenses.add(filtered[i].id);
          renderExpensesList();
          return;
        }
      }
      lastClickedExpenseId = id;
      if (selectedExpenses.size > 0) {
        if (selectedExpenses.has(id)) selectedExpenses.delete(id); else selectedExpenses.add(id);
        renderExpensesList();
      } else {
        const exp = expenses.find(ex => ex.id === id);
        if (exp) openExpenseModal(exp);
      }
    });
  });

  // Bulk bar actions
  area.querySelector('.exp-bulk-delete')?.addEventListener('click', async () => {
    const ids = [...selectedExpenses];
    if (!confirm(`Delete ${ids.length} expense${ids.length !== 1 ? 's' : ''}?`)) return;
    expenses = expenses.filter(e => !selectedExpenses.has(e.id));
    selectedExpenses.clear();
    renderExpensesCatBar(); renderExpensesList();
    try { await Promise.all(ids.map(id => apiCall('DELETE', '/expenses/' + id))); } catch(e) { toast('Some deletes failed'); }
  });
  area.querySelector('.exp-bulk-clear')?.addEventListener('click', () => {
    selectedExpenses.clear(); lastClickedExpenseId = null; renderExpensesList();
  });

  area.querySelectorAll('.exp-hdr').forEach(el => {
    // Click cycles: unsorted → asc → desc → off (removed from chain)
    el.addEventListener('click', e => {
      const col = el.dataset.col;
      const existing = expenseSortCols.findIndex(s => s.col === col);
      if (existing === -1) {
        expenseSortCols.push({ col, dir: col === 'amount' ? 'desc' : 'asc' });
      } else if (expenseSortCols[existing].dir === (col === 'amount' ? 'desc' : 'asc')) {
        expenseSortCols[existing].dir = col === 'amount' ? 'asc' : 'desc';
      } else {
        expenseSortCols.splice(existing, 1);
      }
      renderExpensesList();
    });
    // Drag to reorder
    el.addEventListener('dragstart', e => {
      expenseDragCol = el.dataset.col;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('exp-hdr-dragging'), 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('exp-hdr-dragging', 'exp-hdr-drop-left', 'exp-hdr-drop-right');
      expenseDragCol = null;
    });
    el.addEventListener('dragover', e => {
      if (!expenseDragCol || expenseDragCol === el.dataset.col) return;
      e.preventDefault();
      const mid = el.getBoundingClientRect().left + el.offsetWidth / 2;
      el.classList.toggle('exp-hdr-drop-left',  e.clientX < mid);
      el.classList.toggle('exp-hdr-drop-right', e.clientX >= mid);
    });
    el.addEventListener('dragleave', () => el.classList.remove('exp-hdr-drop-left', 'exp-hdr-drop-right'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      const toKey = el.dataset.col;
      el.classList.remove('exp-hdr-drop-left', 'exp-hdr-drop-right');
      if (!expenseDragCol || expenseDragCol === toKey) return;
      const insertBefore = e.clientX < el.getBoundingClientRect().left + el.offsetWidth / 2;
      const fromIdx = expenseColOrder.indexOf(expenseDragCol);
      expenseColOrder.splice(fromIdx, 1);
      const toIdx = expenseColOrder.indexOf(toKey);
      expenseColOrder.splice(insertBefore ? toIdx : toIdx + 1, 0, expenseDragCol);
      expenseDragCol = null;
      localStorage.setItem('expense-col-order', JSON.stringify(expenseColOrder));
      renderExpensesList();
    });
  });

  document.getElementById('expense-add-inline-btn')?.addEventListener('click', () => openExpenseModal());

  area.querySelectorAll('.exp-col-resize').forEach(handle => {
    const hdr = handle.parentElement;
    handle.addEventListener('mouseenter', () => { hdr.draggable = false; });
    handle.addEventListener('mouseleave', () => { hdr.draggable = true; });
    handle.addEventListener('mousedown', e => {
      e.stopPropagation();
      e.preventDefault();
      hdr.draggable = false;
      const col = handle.dataset.col;
      const startWidth = hdr.getBoundingClientRect().width;
      const startX = e.clientX;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const onMove = ev => {
        expenseColWidths[col] = Math.max(40, Math.round(startWidth + ev.clientX - startX));
        updateExpenseGrid();
      };
      const onUp = () => {
        hdr.draggable = true;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('expense-col-widths', JSON.stringify(expenseColWidths));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('dblclick', e => {
      e.stopPropagation();
      const col = handle.dataset.col;
      const cellClass = COL_CELL_CLASS[col];
      if (!cellClass) return;
      let maxW = 0;
      area.querySelectorAll('.' + cellClass).forEach(cell => { maxW = Math.max(maxW, cell.scrollWidth); });
      const labelW = handle.parentElement.querySelector(':not(.exp-col-resize)')?.scrollWidth || 0;
      maxW = Math.max(maxW, labelW + 16);
      expenseColWidths[col] = maxW + 24;
      updateExpenseGrid();
      localStorage.setItem('expense-col-widths', JSON.stringify(expenseColWidths));
    });
  });

  area.querySelectorAll('.expense-entry-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Delete this expense?')) return;
      expenses = expenses.filter(exp => exp.id !== id);
      renderExpensesCatBar(); renderExpensesList();
      try { await apiCall('DELETE', '/expenses/' + id); } catch(err) {}
    });
  });
}

function renderExpenseCatsList() {
  const list = document.getElementById('expense-cats-list');
  if (!list) return;
  const sortedCats = [...expenseCategories].sort((a, b) => a.name.localeCompare(b.name));
  const datalist = document.getElementById('exp-cat-list');
  if (datalist) datalist.innerHTML = sortedCats.map(c => `<option value="${escHtml(c.name)}">`).join('');
  list.innerHTML = sortedCats.map(c => `
    <div class="expense-cat-item">
      <span class="expense-cat-name">${escHtml(c.name)}</span>
      <button class="expense-cat-del" data-name="${escHtml(c.name)}">✕</button>
    </div>
  `).join('') + `<div class="expense-cat-add">
    <input class="expense-cat-input" id="expense-cat-input" placeholder="New category…" autocomplete="off">
  </div>`;
  list.querySelectorAll('.expense-cat-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      expenseCategories = expenseCategories.filter(c => c.name !== name);
      renderExpenseCatsList();
      try { await apiCall('DELETE', '/expense-categories/' + encodeURIComponent(name)); } catch(e) {}
    });
  });
  document.getElementById('expense-cat-input')?.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const name = e.target.value.trim();
      if (!name) return;
      e.target.value = '';
      try {
        const cat = await apiCall('POST', '/expense-categories', { name });
        if (!expenseCategories.find(c => c.name === cat.name)) expenseCategories.push(cat);
        renderExpenseCatsList();
      } catch(err) { toast('Could not add category'); }
    }
  });
}

function openExpenseModal(expense = null) {
  currentExpenseId = expense?.id || null;
  document.getElementById('expense-modal-label').textContent = expense ? 'Edit Expense' : 'New Expense';
  document.getElementById('expense-modal-delete').style.display = expense ? '' : 'none';
  const today = dpToIso(new Date());
  const dateVal = expense?.date || today;
  document.getElementById('exp-date').value = isoToMdy(dateVal);
  dpInit(dateVal);
  document.getElementById('exp-amount').value = expense ? expense.amount : '';
  document.getElementById('exp-direction').value = expense?.direction || 'withdrawal';
  document.getElementById('exp-category').value = expense?.category || '';
  document.getElementById('exp-payee').value = expense?.payee || '';
  document.getElementById('exp-source').value = expense?.source || '';
  document.getElementById('exp-frequency').value = expense?.frequency || '';
  document.getElementById('exp-note').value = expense?.note || '';
  document.getElementById('exp-pass-through').checked = !!expense?.pass_through;
  const datalist = document.getElementById('exp-cat-list');
  if (datalist) datalist.innerHTML = [...expenseCategories].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${escHtml(c.name)}">`).join('');
  document.getElementById('expense-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('exp-amount').focus(), 30);
}

function closeExpenseModal() {
  document.getElementById('expense-modal').classList.add('hidden');
  currentExpenseId = null;
}

async function saveExpense() {
  const date = document.getElementById('exp-date').value;
  const amount = parseFloat(document.getElementById('exp-amount').value);
  const direction = document.getElementById('exp-direction').value;
  const category = document.getElementById('exp-category').value.trim();
  const payee = document.getElementById('exp-payee').value.trim();
  const source = document.getElementById('exp-source').value.trim();
  const frequency = document.getElementById('exp-frequency').value.trim();
  const note = document.getElementById('exp-note').value.trim();
  const pass_through = document.getElementById('exp-pass-through').checked ? 1 : 0;
  if (!date || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) { toast('Date must be MM/DD/YYYY'); return; }
  const isoDate = mdyToIso(date);
  if (isNaN(amount) || amount < 0) { toast('Valid amount required'); return; }
  const isEdit = !!currentExpenseId;
  if (category && !expenseCategories.find(c => c.name === category)) {
    try {
      const cat = await apiCall('POST', '/expense-categories', { name: category });
      expenseCategories.push(cat);
    } catch(e) {}
  }
  const body = { amount, date: isoDate, category, payee, source, frequency, direction, pass_through, note };
  try {
    if (isEdit) {
      const updated = await apiCall('PUT', '/expenses/' + currentExpenseId, body);
      const idx = expenses.findIndex(e => e.id === currentExpenseId);
      if (idx >= 0) expenses[idx] = updated;
    } else {
      const created = await apiCall('POST', '/expenses', body);
      expenses.unshift(created);
    }
    expenses.sort((a, b) => b.date !== a.date ? b.date.localeCompare(a.date) : b.created_at - a.created_at);
    closeExpenseModal();
    renderExpensesCatBar(); renderExpensesList(); renderExpenseCatsList();
    toast(isEdit ? 'Expense updated' : 'Expense added');
  } catch(e) { toast('Could not save — check connection'); }
}

async function deleteExpense() {
  if (!currentExpenseId) return;
  if (!confirm('Delete this expense?')) return;
  const id = currentExpenseId;
  expenses = expenses.filter(e => e.id !== id);
  closeExpenseModal();
  renderExpensesCatBar(); renderExpensesList();
  try { await apiCall('DELETE', '/expenses/' + id); } catch(e) {}
}

async function exportExpensesCsv() {
  try {
    const res = await fetch('/api/expenses/export.csv', { headers: { 'Authorization': authHeader } });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'expenses.csv'; a.click();
    URL.revokeObjectURL(url);
  } catch(e) { toast('Export failed'); }
}

// ── Calendar / Reminders ───────────────────────────────────────
const RECUR_UNITS = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' };
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function loadCalendar() {
  try { reminders = await apiFetch('GET', '/reminders'); } catch(e) {}
  renderCalendarActive();
  updateNotifsButton();
}

// ≥900px there's room for agenda + month side by side — the header button
// just hides/shows the month pane (calendarMonthVisible). Below that only
// one pane fits, so the button swaps between them instead (calendarViewMode).
const CAL_SPLIT_MQ = window.matchMedia('(min-width: 900px)');

// Agenda and Month share the same `reminders` array; only visible panes
// actually render on each data refresh.
function renderCalendarActive() {
  const split = CAL_SPLIT_MQ.matches;
  const agendaShown = split || calendarViewMode === 'agenda';
  const monthShown = split ? calendarMonthVisible : calendarViewMode === 'month';
  document.getElementById('agenda-list')?.classList.toggle('hidden', !agendaShown);
  document.getElementById('month-cal-view')?.classList.toggle('hidden', !monthShown);
  document.getElementById('calendar-view-body')?.classList.toggle('cal-collapsed', split && !monthShown);
  if (agendaShown) renderAgenda();
  if (monthShown) renderMonthCal();
  updateCalToggleBtn();
}

function updateCalToggleBtn() {
  const btn = document.getElementById('calendar-view-toggle-btn');
  if (!btn) return;
  btn.textContent = CAL_SPLIT_MQ.matches
    ? (calendarMonthVisible ? '🗓 Hide calendar' : '🗓 Show calendar')
    : (calendarViewMode === 'agenda' ? '🗓 Month' : '📋 Agenda');
}

function recurLabel(r) {
  if (r.recur_type === 'none') return '';
  const n = r.recur_interval > 1 ? r.recur_interval + ' ' : '';
  if (r.recur_type === 'weekly' && r.recur_weekdays) {
    const days = r.recur_weekdays.split(',').map(d => WD_SHORT[+d]).join(' ');
    return `↻ every ${n}wk · ${days}`;
  }
  return `↻ every ${n}${RECUR_UNITS[r.recur_type] || r.recur_type}`;
}

function leadLabel(minutes) {
  if (minutes % 1440 === 0) { const d = minutes / 1440; return d + (d === 1 ? ' day' : ' days'); }
  if (minutes % 60 === 0) { const h = minutes / 60; return h + (h === 1 ? ' hr' : ' hrs'); }
  return minutes + ' min';
}

function fmtFireTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// One row per reminder showing its NEXT occurrence (a ↻ badge marks the
// series). Sections: Overdue / Today / Tomorrow / This week / Later.
function renderAgenda() {
  const list = document.getElementById('agenda-list');
  if (!list) return;
  const nowMs = Date.now();
  const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); };
  const todayStart = startOfDay(nowMs);
  const tomorrowStart = todayStart + 86400000; // section bucketing only — fire times come from the server
  const dayAfterStart = tomorrowStart + 86400000;
  const weekEnd = todayStart + 7 * 86400000;

  const buckets = { overdue: [], today: [], tomorrow: [], week: [], later: [], done: [] };
  for (const r of reminders) {
    if (r.completed_at) { buckets.done.push({ r, fireAt: r.completed_at }); continue; }
    const fireAt = r.snoozed_until || r.next_fire_at;
    if (fireAt == null) { buckets.overdue.push({ r, fireAt: r.first_fire_at }); continue; } // fired one-off awaiting done
    if (fireAt < nowMs) buckets.overdue.push({ r, fireAt });
    else if (fireAt < tomorrowStart) buckets.today.push({ r, fireAt });
    else if (fireAt < dayAfterStart) buckets.tomorrow.push({ r, fireAt });
    else if (fireAt < weekEnd) buckets.week.push({ r, fireAt });
    else buckets.later.push({ r, fireAt });
  }
  for (const k in buckets) buckets[k].sort((a, b) => a.fireAt - b.fireAt);
  buckets.done.sort((a, b) => b.fireAt - a.fireAt); // newest done first
  buckets.done = buckets.done.slice(0, 20);

  // opts.timeClass colors the time pill by urgency bucket; the Completed
  // section keeps the old dim plain text so it doesn't fight the 0.5 opacity.
  const section = (label, items, opts = {}) => !items.length ? '' :
    `<div class="agenda-section-label">${label}${opts.clear ? '<button id="clear-completed-btn" class="agenda-clear-btn">Clear completed</button>' : ''}</div>` + items.map(({ r, fireAt }) => `
      <div class="agenda-item${opts.done ? ' agenda-item-done' : ''}" data-id="${r.id}">
        <div class="agenda-item-main">
          <div class="agenda-item-title">${escHtml(r.title)}</div>
          <div class="agenda-item-meta">
            <span class="${opts.done ? 'agenda-item-time' : 'agenda-time ' + (opts.timeClass || 'agenda-time-neutral')}">${opts.done ? 'Done ' : ''}${fmtFireTime(fireAt)}</span>
            ${r.recur_type !== 'none' ? `<span class="agenda-badge">${escHtml(recurLabel(r))}</span>` : ''}
            ${!opts.done && r.lead_minutes ? `<span class="agenda-badge agenda-lead">⏰ ${leadLabel(r.lead_minutes)} before</span>` : ''}
            ${!opts.done && r.snoozed_until ? '<span class="agenda-badge agenda-snoozed">snoozed</span>' : ''}
          </div>
          ${r.description ? `<div class="agenda-item-desc">${escHtml(r.description)}</div>` : ''}
        </div>
        ${!opts.done ? `<button class="agenda-done-btn" data-id="${r.id}" title="Mark done">✓</button>` : ''}
        <button class="agenda-del-btn" data-id="${r.id}" title="Archive">🗄</button>
      </div>`).join('');

  list.innerHTML =
    (section('Overdue', buckets.overdue, { timeClass: 'agenda-time-overdue' }) +
    section('Today', buckets.today, { timeClass: 'agenda-time-today' }) +
    section('Tomorrow', buckets.tomorrow) + section('This week', buckets.week) +
    section('Later', buckets.later) ||
    '<div class="agenda-empty">No reminders — hit + to add one</div>') +
    section('Completed', buckets.done, { done: true, clear: true });

  list.querySelectorAll('.agenda-item').forEach(el => {
    el.addEventListener('click', () => {
      const r = reminders.find(x => x.id === el.dataset.id);
      if (r) openReminderModal(r);
    });
  });
  list.querySelectorAll('.agenda-del-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); archiveReminder(btn.dataset.id); });
  });
  document.getElementById('clear-completed-btn')?.addEventListener('click', e => {
    e.stopPropagation(); clearCompleted();
  });
  list.querySelectorAll('.agenda-done-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        const updated = await apiCall('POST', '/reminders/' + btn.dataset.id + '/complete');
        const idx = reminders.findIndex(x => x.id === updated.id);
        if (idx >= 0) reminders[idx] = updated;
        renderAgenda(); toast('Done');
      } catch(err) {
        toast(String(err.message || '').includes('offline')
          ? 'Offline — will mark done when reconnected' : 'Could not update — check connection');
      }
    });
  });
}

// ── Month calendar ──
// Advance-on-fire means each reminder row only ever knows ONE future
// occurrence, so (like the agenda) a recurring reminder plots a single ↻
// mini-card on its next date, not every future date in the series.
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
const CAL_MAX_SHOWN = 3;

function renderMonthCal() {
  const el = document.getElementById('month-cal-view');
  if (!el) return;
  const nowMs = Date.now();
  const todayIso = dpToIso(new Date());

  const byDay = {};
  for (const r of reminders) {
    if (r.completed_at) continue;
    const fireAt = r.snoozed_until || r.next_fire_at || r.first_fire_at;
    if (fireAt == null) continue;
    const iso = dpToIso(new Date(fireAt));
    if (!byDay[iso]) byDay[iso] = [];
    byDay[iso].push({ r, fireAt });
  }
  for (const iso in byDay) byDay[iso].sort((a, b) => a.fireAt - b.fireAt);

  const first = new Date(calYear, calMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  let cells = [];
  for (let i = 0; i < startDow; i++) {
    const d = new Date(calYear, calMonth, 1 - (startDow - i));
    cells.push({ iso: dpToIso(d), label: d.getDate(), out: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(calYear, calMonth, d);
    cells.push({ iso: dpToIso(dt), label: d, out: false });
  }
  const rem = 7 - (cells.length % 7);
  if (rem < 7) for (let d = 1; d <= rem; d++) {
    const dt = new Date(calYear, calMonth + 1, d);
    cells.push({ iso: dpToIso(dt), label: d, out: true });
  }

  el.innerHTML = `
    <div class="cal-month-header">
      <button class="cal-month-nav" id="cal-month-prev" type="button">‹</button>
      <span class="cal-month-label">${DP_MONTHS[calMonth]} ${calYear}</span>
      <button class="cal-month-nav" id="cal-month-next" type="button">›</button>
    </div>
    <div class="cal-month-grid">
      ${DP_DAYS.map(d => `<div class="cal-month-dow">${d}</div>`).join('')}
      ${cells.map(c => {
        const items = byDay[c.iso] || [];
        const shown = items.slice(0, CAL_MAX_SHOWN);
        const overflow = items.length - shown.length;
        return `<div class="cal-month-day${c.out ? ' cal-day-out' : ''}${c.iso === todayIso ? ' cal-day-today' : ''}" data-iso="${c.iso}">
          <span class="cal-day-num">${c.label}</span>
          <div class="cal-day-items">
            ${shown.map(({ r, fireAt }) => `<div class="cal-mini-card${fireAt < nowMs ? ' cal-mini-overdue' : ''}" data-id="${r.id}" title="${escHtml(r.title)}">${r.recur_type !== 'none' ? '↻ ' : ''}${escHtml(r.title)}</div>`).join('')}
            ${overflow > 0 ? `<div class="cal-mini-more">+${overflow} more</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;

  el.querySelector('#cal-month-prev').addEventListener('click', () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderMonthCal();
  });
  el.querySelector('#cal-month-next').addEventListener('click', () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderMonthCal();
  });
  el.querySelectorAll('.cal-mini-card').forEach(card => {
    card.addEventListener('click', e => {
      e.stopPropagation();
      const r = reminders.find(x => x.id === card.dataset.id);
      if (r) openReminderModal(r);
    });
  });
  el.querySelectorAll('.cal-month-day').forEach(dayEl => {
    dayEl.addEventListener('click', () => {
      openReminderModal();
      document.getElementById('rem-date').value = isoToMdy(dayEl.dataset.iso);
    });
  });
}

// ── Reminder modal ──
function updateRecurRows() {
  const type = document.getElementById('rem-recur').value;
  document.getElementById('rem-interval-row').classList.toggle('hidden', type === 'none');
  document.getElementById('rem-end-row').classList.toggle('hidden', type === 'none');
  document.getElementById('rem-weekdays-row').classList.toggle('hidden', type !== 'weekly');
  document.getElementById('rem-interval-unit').textContent = RECUR_UNITS[type] || '';
}

function renderWeekdayPills() {
  document.querySelectorAll('#rem-weekdays .rem-wd').forEach(b =>
    b.classList.toggle('active', remWeekdaySel.has(+b.dataset.d)));
}

function openReminderModal(reminder = null) {
  currentReminderId = reminder?.id || null;
  document.getElementById('reminder-modal-label').textContent = reminder ? 'Edit Reminder' : 'New Reminder';
  document.getElementById('reminder-modal-delete').style.display = reminder ? '' : 'none';
  document.getElementById('rem-title').value = reminder?.title || '';
  document.getElementById('rem-desc').value = reminder?.description || '';
  const base = reminder ? new Date(reminder.first_fire_at) : new Date(Date.now() + 3600000);
  const iso = dpToIso(base);
  document.getElementById('rem-date').value = isoToMdy(iso);
  dpInit(iso, 'rem-date', 'rem-date-cal');
  document.getElementById('rem-time').value =
    String(base.getHours()).padStart(2,'0') + ':' + String(base.getMinutes()).padStart(2,'0');
  const lm = reminder?.lead_minutes || null;
  const leadEl = document.getElementById('rem-lead'), leadUnitEl = document.getElementById('rem-lead-unit');
  if (lm && lm % 1440 === 0) { leadEl.value = lm / 1440; leadUnitEl.value = '1440'; }
  else if (lm && lm % 60 === 0) { leadEl.value = lm / 60; leadUnitEl.value = '60'; }
  else { leadEl.value = lm || ''; leadUnitEl.value = '1'; }
  leadUnitEl.disabled = !leadEl.value;
  document.getElementById('rem-recur').value = reminder?.recur_type || 'none';
  document.getElementById('rem-interval').value = reminder?.recur_interval || 1;
  remWeekdaySel.clear();
  (reminder?.recur_weekdays || '').split(',').filter(s => s !== '').forEach(d => remWeekdaySel.add(+d));
  renderWeekdayPills();
  document.getElementById('rem-end').value = reminder?.recur_end_at ? isoToMdy(dpToIso(new Date(reminder.recur_end_at))) : '';
  updateRecurRows();
  document.getElementById('reminder-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('rem-title').focus(), 30);
}

function closeReminderModal() {
  document.getElementById('reminder-modal').classList.add('hidden');
  currentReminderId = null;
}

async function saveReminder() {
  const title = document.getElementById('rem-title').value.trim();
  if (!title) { toast('Title required'); return; }
  const dateStr = document.getElementById('rem-date').value;
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) { toast('Date must be MM/DD/YYYY'); return; }
  const timeStr = document.getElementById('rem-time').value || '09:00';
  const [m, d, y] = dateStr.split('/').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Device local time == LA for this deployment (single-timezone by design)
  const first_fire_at = new Date(y, m - 1, d, hh, mm).getTime();
  const recur_type = document.getElementById('rem-recur').value;
  const recur_interval = Math.max(1, parseInt(document.getElementById('rem-interval').value, 10) || 1);
  const recur_weekdays = recur_type === 'weekly' && remWeekdaySel.size ? [...remWeekdaySel].sort().join(',') : null;
  let recur_end_at = null;
  const endStr = document.getElementById('rem-end').value.trim();
  if (recur_type !== 'none' && endStr) {
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(endStr)) { toast('End date must be MM/DD/YYYY'); return; }
    const [em, ed, ey] = endStr.split('/').map(Number);
    recur_end_at = new Date(ey, em - 1, ed, 23, 59).getTime();
  }
  const leadRaw = document.getElementById('rem-lead').value.trim();
  const leadN = parseInt(leadRaw, 10);
  const lead_minutes = leadRaw !== '' && Number.isInteger(leadN) && leadN > 0
    ? leadN * +document.getElementById('rem-lead-unit').value : null;
  const body = { title, description: document.getElementById('rem-desc').value.trim(),
    first_fire_at, recur_type, recur_interval, recur_weekdays, recur_end_at, lead_minutes };
  const isEdit = !!currentReminderId;
  try {
    if (isEdit) {
      const updated = await apiCall('PUT', '/reminders/' + currentReminderId, body);
      const idx = reminders.findIndex(r => r.id === updated.id);
      if (idx >= 0) reminders[idx] = updated;
    } else {
      reminders.push(await apiCall('POST', '/reminders', body));
    }
    closeReminderModal(); renderCalendarActive();
    toast(isEdit ? 'Reminder updated' : 'Reminder added');
  } catch(e) {
    // apiCall queues non-GET writes while offline and replays them on
    // reconnect — say so honestly instead of inviting a duplicate retry.
    if (String(e.message || '').includes('offline')) {
      closeReminderModal();
      toast('Offline — reminder will save when reconnected');
    } else {
      toast('Could not save: ' + (String(e.message || '').match(/"error":"([^"]+)"/)?.[1] || 'check connection'));
    }
  }
}

// Called with an explicit id from the inline agenda 🗄, without one from the
// modal's Archive button (falls back to the open reminder).
async function archiveReminder(id) {
  id = typeof id === 'string' ? id : currentReminderId;
  if (!id) return;
  if (!confirm('Archive this reminder?')) return;
  reminders = reminders.filter(r => r.id !== id);
  if (id === currentReminderId) closeReminderModal();
  renderCalendarActive();
  try { await apiCall('POST', '/reminders/' + id + '/archive'); } catch(e) {}
}

async function clearCompleted() {
  const n = reminders.filter(r => r.completed_at).length;
  if (!n) return;
  if (!confirm(`Delete ${n} completed reminder${n > 1 ? 's' : ''}? (They can still be restored from Trash.)`)) return;
  reminders = reminders.filter(r => !r.completed_at);
  renderAgenda();
  try { await apiCall('DELETE', '/reminders/completed'); } catch(e) {}
}

// ── Calls tab (Twilio dialer) ──────────────────────────────────
// Outbound-only browser dialer. The server issues short-lived tokens
// (/api/twilio/token); TwiML + dual-channel recording happen server-side.
// Every call auto-records; the log below the pad plays recordings inline.

function fmtPhone(n) {
  const m = String(n || '').match(/^\+1([2-9]\d{2})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || '');
}

function fmtCallDur(secs) {
  secs = parseInt(secs, 10) || 0;
  return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

// Same rules as the server's normalizeE164 — US-default.
function normalizeDialNumber(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
  if (/^1\d{10}$/.test(d)) return '+' + d;
  if (/^[2-9]\d{9}$/.test(d)) return '+1' + d;
  return null;
}

function setDialerStatus(msg, cls) {
  const el = document.getElementById('dialer-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'dialer-status' + (cls ? ' ' + cls : '');
}

function fmtUsd(n) { return '$' + (n || 0).toFixed(2); }

// Refetched every time the tab opens (unlike the Device, which is a one-time
// singleton) — balance moves every call, so a stale glance is worse than none.
async function loadUsagePanel() {
  const els = [document.getElementById('calls-usage-info'), document.getElementById('dialer-usage-info')].filter(Boolean);
  if (!els.length) return;
  try {
    const u = await apiFetch('GET', '/twilio/usage');
    els.forEach(el => el.innerHTML = `Balance <b>${escHtml(fmtUsd(u.balance))}</b> · today ${escHtml(fmtUsd(u.spentToday))} · this month ${escHtml(fmtUsd(u.spentThisMonth))}`);
  } catch(e) { els.forEach(el => el.innerHTML = ''); } // not configured / offline — just stay quiet, dialer status already covers real errors
}

// rfy-crm: dialing always happens from inside a lead's Calls sub-tab, so the
// lead is captured at dial time (context can change mid-call — the user can
// browse other leads while talking, that's the whole point of the float bar).
let crmCallLeadId = null;   // lead the LIVE call belongs to
let crmCallNumber = '';     // number of the live call, for the float bar

// ── Inbound calls (v161): ring banner + phone-style switch ──────────────
// A lead calling back rings here (Device.register + incomingAllow). Banner
// shows who it is (matched by last-10 digits against leads.phone_number).
// Accept mid-dial hangs up the current call first — no hold, deliberately:
// finish-or-switch covers a solo cold caller, hold would mean rearchitecting
// every call through conferences.
let twIncoming = null;         // pending incoming Call (ringing, not accepted)
let crmCallInbound = false;    // live call is inbound → no auto-advance after
let crmCallFromQueue = false;  // dialed from a lead's Calls sub-tab → auto-advance after disposition
let switchingToInbound = false; // suppress the disposition modal for the call we hang up on switch

function clientLast10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }
function leadForNumber(num) {
  const t = clientLast10(num);
  return t.length === 10 ? leads.find(l => clientLast10(l.phone_number) === t) : null;
}

function handleIncomingCall(call) {
  twIncoming = call;
  // Leads may not be loaded yet (banner can fire from any tab) — fetch so
  // the caller gets a name instead of a bare number.
  if (!leads.length) apiCall('GET', '/leads').then(ls => { leads = ls; if (twIncoming === call) renderIncomingBanner(); }).catch(() => {});
  renderIncomingBanner();
  const clear = () => { if (twIncoming === call) { twIncoming = null; hideIncomingBanner(); } };
  call.on('cancel', clear);     // caller hung up or the 15s server timeout sent them to voicemail
  call.on('disconnect', clear);
  call.on('reject', clear);
}

function renderIncomingBanner() {
  const bar = document.getElementById('incoming-call-bar');
  if (!bar || !twIncoming) return;
  const from = twIncoming.parameters.From || '';
  const lead = leadForNumber(from);
  document.getElementById('incoming-call-who').textContent =
    (lead ? lead.business_name + ' · ' : '') + (fmtPhone(from) || from || 'Unknown');
  document.getElementById('incoming-accept').textContent = twCall ? 'End current + Accept' : 'Accept';
  bar.classList.remove('hidden');
}
function hideIncomingBanner() { document.getElementById('incoming-call-bar')?.classList.add('hidden'); }

async function acceptIncoming() {
  const call = twIncoming;
  if (!call) return;
  twIncoming = null;
  hideIncomingBanner();
  if (twCall) {
    // Phone-style switch: end the current call quietly — no disposition
    // modal for a dial you abandoned to take a hotter callback.
    switchingToInbound = true;
    try { twCall.disconnect(); } catch (e) {}
  }
  const from = call.parameters.From || '';
  const lead = leadForNumber(from);
  crmCallLeadId = lead ? lead.id : null;
  crmCallInbound = true;
  crmCallFromQueue = false;
  crmCallNumber = from;
  call.on('disconnect', endCallUi);
  call.on('cancel', endCallUi);
  call.on('error', err => { console.warn('twilio incoming call error:', err); endCallUi(); });
  try { call.accept(); } catch (e) { console.warn('accept failed:', e); endCallUi(); return; }
  twCall = call;
  document.getElementById('dial-call-btn')?.classList.add('hidden');
  document.getElementById('dial-hangup-btn')?.classList.remove('hidden');
  startCallTimer();
  // Jump to the caller's lead so notes/history are in front of you.
  if (lead) { if (currentTab !== 'crm') switchTab('crm'); openLead(lead.id, 'calls'); }
}

function declineIncoming() {
  const call = twIncoming;
  twIncoming = null;
  hideIncomingBanner();
  try { call?.reject(); } catch (e) {} // caller falls through to voicemail
}

function showCallFloatBar(text) {
  const bar = document.getElementById('call-float-bar');
  if (!bar) return;
  document.getElementById('call-float-status').textContent = text;
  bar.classList.remove('hidden');
}
function hideCallFloatBar() {
  document.getElementById('call-float-bar')?.classList.add('hidden');
}

async function refreshDialerToken() {
  const { token, callerId } = await apiFetch('GET', '/twilio/token');
  twTokenAt = Date.now();
  dialerCallerId = callerId || dialerCallerId;
  return token;
}

async function initDialer() {
  if (twDevice) return;
  if (!window.TwilioVoice) { setDialerStatus('Dialer failed to load — refresh the app'); return; }
  try {
    const token = await refreshDialerToken();
    const info = document.getElementById('calls-panel-info');
    if (info) info.innerHTML = `Calling from<br><span class="calls-panel-num">${escHtml(fmtPhone(dialerCallerId))}</span><br><br>Every call records automatically — playback in the log.`;
    twDevice = new TwilioVoice.Device(token, { logLevel: 'error' });
    // Tokens live 1h; during an active signaling stream the SDK warns before
    // expiry — refresh in place. (An IDLE device never fires this — the
    // signaling stream only exists after the first connect — so startCall
    // also age-checks the token before dialing.)
    twDevice.on('tokenWillExpire', async () => {
      try { twDevice.updateToken(await refreshDialerToken()); } catch(e) {}
    });
    twDevice.on('error', async err => {
      console.warn('twilio device error:', err);
      // 20101/20104 = invalid/expired token — recover in place, don't strand the tab.
      if (err && (err.code === 20101 || err.code === 20104)) {
        try { twDevice.updateToken(await refreshDialerToken()); setDialerStatus('Ready', 'dialer-status-ready'); return; } catch(e) {}
      }
      setDialerStatus('Dialer error — ' + (err.message || err.code), 'dialer-status-err');
    });
    // Inbound (v161): register() opens the signaling stream so lead callbacks
    // ring here (outbound-only never needed it). Also means tokenWillExpire
    // now fires even while idle, keeping the token fresh for free.
    twDevice.on('incoming', handleIncomingCall);
    try { await twDevice.register(); } catch (e) { console.warn('twilio register failed:', e); }
    setDialerStatus('Ready', 'dialer-status-ready');
  } catch(e) {
    setDialerStatus(String(e.message || '').includes('not configured')
      ? 'Twilio not configured on the server' : 'Could not reach server', 'dialer-status-err');
  }
}

function startCallTimer() {
  const start = Date.now();
  clearInterval(callTimerInt);
  callTimerInt = setInterval(() => {
    const t = fmtCallDur(Math.round((Date.now() - start) / 1000));
    setDialerStatus('In call · ' + t, 'dialer-status-live');
    showCallFloatBar('In call ' + fmtPhone(crmCallNumber) + ' · ' + t);
  }, 1000);
  setDialerStatus('In call · 0:00', 'dialer-status-live');
  showCallFloatBar('In call ' + fmtPhone(crmCallNumber) + ' · 0:00');
}

function endCallUi(callRef) {
  // Twilio passes the Call as the event arg. If it isn't the CURRENT call,
  // this is the stale disconnect of a dial we hung up while switching to an
  // incoming call — swallow it, the new call owns the UI now.
  if (callRef && typeof callRef === 'object' && twCall && callRef !== twCall) { switchingToInbound = false; return; }
  clearInterval(callTimerInt); callTimerInt = null;
  const endedLeadId = crmCallLeadId;
  crmCallLeadId = null;
  const inbound = crmCallInbound;
  crmCallInbound = false;
  const fromQueue = crmCallFromQueue;
  crmCallFromQueue = false;
  const suppressed = switchingToInbound;
  switchingToInbound = false;
  const wasLive = !!twCall;
  twCall = null;
  twDialing = false;
  hideCallFloatBar();
  document.getElementById('dial-call-btn')?.classList.remove('hidden');
  document.getElementById('dial-hangup-btn')?.classList.add('hidden');
  setDialerStatus('Ready', 'dialer-status-ready');
  // The recording takes a few seconds to process server-side; the 2s sync
  // poll picks it up (the payload fingerprint changes), no refresh needed here.
  loadUsagePanel(); // balance just moved
  // rfy-crm §1.6/1.7: a lead-scoped call that actually connected surfaces the
  // disposition picker, then auto-advances to the next lead in list order.
  // wasLive filters out dials that never got past "Connecting…" (mic blocked,
  // connect() rejected). Inbound callbacks get the picker too but never
  // auto-advance (you weren't queue-dialing them). A call abandoned to take
  // an incoming one (suppressed) gets no picker at all.
  // Auto-advance only for queue dialing (from a lead's Calls sub-tab) —
  // inbound callbacks and standalone-Dialer calls just close after picking.
  if (wasLive && endedLeadId && !suppressed) openDispositionModal(endedLeadId, { advance: !inbound && fromQueue });
}

async function startCall() {
  // twDialing guards the async window before connect() resolves — twCall
  // alone would let a double-click place two simultaneous billable calls.
  if (twCall || twDialing) return;
  const num = normalizeDialNumber(document.getElementById('dial-number').value);
  if (!num) { toast('Enter a valid phone number'); return; }
  twDialing = true;
  if (!twDevice) { await initDialer(); if (!twDevice) { twDialing = false; return; } }
  // An idle Device never hears tokenWillExpire (no signaling stream until the
  // first connect) — a stale token would fail every call until a page reload.
  if (Date.now() - twTokenAt > 50 * 60000) {
    try { twDevice.updateToken(await refreshDialerToken()); } catch(e) {}
  }
  // Capture the lead context at dial time — the disposition/auto-advance flow
  // uses this, not whatever lead happens to be open when the call ends.
  // From a lead's Calls sub-tab: that lead, and it counts as queue dialing
  // (auto-advance after disposition). From the standalone Dialer: link by
  // phone match if the number belongs to a lead, and never auto-advance.
  const inCrm = dialerInCrm();
  crmCallLeadId = inCrm ? (currentLeadId || null) : (leadForNumber(num)?.id || null);
  crmCallFromQueue = inCrm && !!currentLeadId;
  crmCallInbound = false;
  crmCallNumber = num;
  setDialerStatus('Connecting…');
  showCallFloatBar('Calling ' + fmtPhone(num) + '…');
  document.getElementById('dial-call-btn').classList.add('hidden');
  document.getElementById('dial-hangup-btn').classList.remove('hidden');
  const prospectIdForCall = dialingProspectId; dialingProspectId = null;
  try {
    // Triggers the mic permission prompt on first use. LeadId/ProspectId are
    // custom params the /api/twilio/voice webhook validates and stamps on
    // the calls row (ProspectId only set when dialed via dialProspect()).
    twCall = await twDevice.connect({ params: { To: num, LeadId: crmCallLeadId || '', ProspectId: prospectIdForCall || '' } });
  } catch(e) {
    console.warn('twilio connect failed:', e);
    const msg = String(e && (e.message || e.name) || '');
    toast(/Permission|NotAllowed/i.test(msg) ? 'Microphone blocked — allow it in browser settings' : 'Could not start call');
    endCallUi();
    return;
  }
  twCall.on('ringing', () => { setDialerStatus('Ringing ' + fmtPhone(num) + '…'); showCallFloatBar('Ringing ' + fmtPhone(num) + '…'); });
  twCall.on('accept', startCallTimer);
  twCall.on('disconnect', endCallUi);
  twCall.on('cancel', endCallUi);
  twCall.on('error', err => {
    console.warn('twilio call error:', err);
    toast('Call error — ' + (err.message || err.code));
    endCallUi();
  });
}

// disconnectAll covers the window where connect() hasn't resolved yet —
// otherwise Hang Up is dead exactly when a stuck "Connecting…" needs it.
function hangUp() {
  if (twCall) twCall.disconnect();
  else if (twDevice) { twDevice.disconnectAll(); endCallUi(); }
}

// Keypad: appends digits while idle, sends DTMF tones (phone-tree navigation)
// while a call is live.
function dialKeyPress(k) {
  if (twCall) { twCall.sendDigits(k); return; }
  const input = document.getElementById('dial-number');
  input.value += k;
  input.focus();
}

const CALL_STATUS_LABEL = {
  'completed': { label: 'Completed', cls: 'call-status-ok' },
  'answered':  { label: 'Completed', cls: 'call-status-ok' },
  'no-answer': { label: 'No answer', cls: 'call-status-bad' },
  'busy':      { label: 'Busy',      cls: 'call-status-bad' },
  'failed':    { label: 'Failed',    cls: 'call-status-bad' },
  'canceled':  { label: 'Canceled',  cls: 'call-status-dim' },
  'initiated': { label: 'In progress', cls: 'call-status-dim' },
};

const openCallNotesIds = new Set(); // call ids with the feedback-notes panel expanded — survives re-renders
const selectedCalls = new Set(); // bulk-select state — same pattern as selectedProspects/selectedExpenses
let lastClickedCallId = null;    // shift-click range anchor

// Same name a call would show once its prospect/lead is looked up — lead_id
// only gets stamped when a number matches an EXISTING lead at dial time
// (leadForNumber), so a prospect dialed before it was promoted never gets
// one; fall back to the prospect it was actually dialed as.
function callDisplayName(c) {
  if (c.lead_id) return leads.find(l => l.id === c.lead_id)?.business_name || null;
  if (c.prospect_id) return allProspects.find(p => p.id === c.prospect_id)?.name || null;
  return null;
}

// Same categorization the row badge shows — shared with the status filter
// bar so its pills always match what's actually on screen.
function callStatusInfo(c) {
  const inbound = c.direction === 'inbound';
  return inbound && c.status === 'missed'
    ? (c.recording_sid ? { label: 'Voicemail', cls: 'call-status-bad' } : { label: 'Missed', cls: 'call-status-bad' })
    : inbound && c.status === 'ringing' ? { label: 'Ringing', cls: 'call-status-dim' }
    : CALL_STATUS_LABEL[c.status] || { label: c.status, cls: 'call-status-dim' };
}
const CALL_STATUS_COLOR = { 'call-status-ok': '#5fc83b', 'call-status-bad': '#f87171', 'call-status-dim': '#888' };
let activeCallStatus = null; // one status label, or null for "all" — same single-select pattern as the Notes/Projects tag filter bars

function renderCallStatusFilterBar(scopedCalls) {
  const byLabel = new Map();
  scopedCalls.forEach(c => { const st = callStatusInfo(c); if (!byLabel.has(st.label)) byLabel.set(st.label, st.cls); });
  if (byLabel.size < 2 && !activeCallStatus) return ''; // not worth a filter bar for a single status type
  const pills = [...byLabel.entries()].map(([label, cls]) =>
    `<span class="tag-filter-pill${label === activeCallStatus ? ' active' : ''}" data-status="${escHtml(label)}" style="--tag-c:${CALL_STATUS_COLOR[cls] || '#888'}">${escHtml(label)}</span>`
  ).join('');
  return `<div class="tags-bar" id="call-status-filter-bar">${pills}${activeCallStatus ? `<span class="tag-filter-clear" id="call-status-clear">✕</span>` : ''}</div>`;
}

// `fromPoll` marks the automatic 2s-sync redraw. That one has to hold back
// while a recording is playing or a feedback note is being typed, or an
// innerHTML rebuild kills the audio and eats the half-typed note. A redraw the
// user actually asked for — deleting a call, tapping a status filter — always
// goes through; the old guard applied to both and silently swallowed those
// clicks whenever a recording happened to be open.
function renderCallLog(opts) {
  const log = document.getElementById('call-log');
  if (!log) return;
  if (opts && opts.fromPoll && (log.querySelector('audio') || log.querySelector('.call-notes-input:focus'))) return;
  // Context-sensitive: inside a lead's Calls sub-tab show only that lead's
  // calls; in the standalone Dialer tab show everything (with a name chip on
  // linked rows). Pre-CRM calls have no lead_id (never backfilled, §1.8).
  const inCrm = dialerInCrm();
  const scopedCalls = inCrm && currentLeadId ? calls.filter(c => c.lead_id === currentLeadId) : calls;
  // Prune selection against the full scoped set (not just what's visible under the
  // current status filter) so switching filters — e.g. Missed then Voicemail — can
  // build up one combined selection to bulk-delete together, and a call deleted
  // elsewhere (another device) drops out instead of leaving a stale ghost selection.
  const scopedIds = new Set(scopedCalls.map(c => c.id));
  [...selectedCalls].forEach(id => { if (!scopedIds.has(id)) selectedCalls.delete(id); });
  const filterBarHtml = renderCallStatusFilterBar(scopedCalls);
  const leadCalls = activeCallStatus ? scopedCalls.filter(c => callStatusInfo(c).label === activeCallStatus) : scopedCalls;
  if (!scopedCalls.length) {
    log.innerHTML = `<div class="agenda-empty">${inCrm ? 'No calls for this lead yet — dial the number above' : 'No calls yet — dial a number above'}</div>`;
    return;
  }
  if (!leadCalls.length) {
    log.innerHTML = '<div class="agenda-section-label">Call log</div>' + filterBarHtml + `<div class="agenda-empty">No ${escHtml(activeCallStatus)} calls</div>`;
    wireCallStatusFilter(log);
    return;
  }
  const anySelected = selectedCalls.size > 0;
  const allVisibleSelected = leadCalls.every(c => selectedCalls.has(c.id));
  // Always the same one row (never swapped for a second variant) so selecting/clearing
  // can patch it in place — see paintCallSelection — instead of a full renderCallLog(),
  // which the audio/notes-focus guard above would silently swallow mid-playback.
  const bulkBarHtml = `
    <div class="exp-bulk-bar prospect-bulk-bar" id="call-bulk-bar">
      <label class="prospect-select-all-wrap"><input type="checkbox" class="call-select-all"${allVisibleSelected ? ' checked' : ''}> Select all</label>
      <span class="exp-bulk-count${anySelected ? '' : ' hidden'}" id="call-bulk-count">${selectedCalls.size} selected</span>
      <button class="exp-bulk-delete${anySelected ? '' : ' hidden'}" id="call-bulk-delete">Delete selected</button>
      <button class="exp-bulk-clear${anySelected ? '' : ' hidden'}" id="call-bulk-clear">Clear</button>
    </div>`;
  log.innerHTML = '<div class="agenda-section-label">Call log</div>' + filterBarHtml + bulkBarHtml + leadCalls.map(c => {
    const st = callStatusInfo(c);
    const inbound = c.direction === 'inbound';
    const num = inbound ? c.from_number : c.to_number;
    const chipName = !inCrm ? callDisplayName(c) : null;
    const notesOpen = openCallNotesIds.has(c.id);
    return `<div class="call-item${c.starred ? ' starred' : ''}${selectedCalls.has(c.id) ? ' selected' : ''}" data-id="${c.id}">
      <div class="call-item-header">
        <div class="call-item-left">
          <input type="checkbox" class="call-item-check" data-id="${c.id}"${selectedCalls.has(c.id) ? ' checked' : ''}>
          <div class="call-item-id">
          ${chipName ? `<div class="call-item-name${c.lead_id || c.prospect_id ? ' call-item-name-link' : ''}"${c.lead_id ? ` data-jump-type="lead" data-jump-id="${escHtml(c.lead_id)}"` : c.prospect_id ? ` data-jump-type="prospect" data-jump-id="${escHtml(c.prospect_id)}"` : ''}>${escHtml(chipName)}</div>` : ''}
          <div class="call-item-number">${inbound ? '<span class="call-dir-in" title="Incoming">↙</span> ' : ''}${escHtml(fmtPhone(num))}</div>
          </div>
        </div>
        <div class="call-item-actions">
          <button class="call-star-btn${c.starred ? ' starred' : ''}" data-star-id="${c.id}" title="${c.starred ? 'Unstar' : 'Star'}">${c.starred ? '★' : '☆'}</button>
          <button class="call-notes-btn${c.notes ? ' has-notes' : ''}" data-notes-id="${c.id}" title="Notes">📝</button>
          ${c.recording_sid ? `
            <button class="call-play-btn" data-sid="${escHtml(c.recording_sid)}" title="Play recording">▶</button>
            <button class="call-dl-btn" data-sid="${escHtml(c.recording_sid)}" data-num="${escHtml(c.to_number)}" data-ts="${c.started_at}" title="Download recording">↓</button>` : ''}
          <button class="call-del-btn" data-id="${escHtml(c.id)}" title="Delete call">🗑</button>
        </div>
      </div>
      <div class="call-item-meta">
        <span class="agenda-time agenda-time-neutral">${escHtml(fmtFireTime(c.started_at))}</span>
        <span class="call-status ${st.cls}">${escHtml(st.label)}</span>
        ${c.duration ? `<span class="call-dur">${escHtml(fmtCallDur(c.duration))}</span>` : ''}
      </div>
      <div class="call-audio-slot" id="call-audio-${escHtml(c.recording_sid || c.id)}"></div>
      <div class="call-notes-wrap${notesOpen ? '' : ' hidden'}" data-notes-wrap="${c.id}">
        <textarea class="call-notes-input" data-id="${c.id}" placeholder="Feedback for yourself on this call…">${escHtml(c.notes || '')}</textarea>
      </div>
    </div>`;
  }).join('');
  log.querySelectorAll('.call-star-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleCallStar(btn.dataset.starId));
  });
  log.querySelectorAll('.call-item-name-link').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.jumpType === 'lead') jumpToLead(el.dataset.jumpId);
      else jumpToProspect(el.dataset.jumpId);
    });
  });
  log.querySelectorAll('.call-notes-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.notesId;
      if (openCallNotesIds.has(id)) openCallNotesIds.delete(id); else openCallNotesIds.add(id);
      document.querySelector(`[data-notes-wrap="${id}"]`)?.classList.toggle('hidden');
    });
  });
  log.querySelectorAll('.call-notes-input').forEach(ta => {
    ta.addEventListener('input', () => saveCallNoteDebounced(ta.dataset.id, ta.value));
  });
  log.querySelectorAll('.call-play-btn').forEach(btn => {
    btn.addEventListener('click', () => playRecording(btn.dataset.sid, btn));
  });
  log.querySelectorAll('.call-dl-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadRecording(btn.dataset.sid, btn.dataset.num, +btn.dataset.ts));
  });
  log.querySelectorAll('.call-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteCall(btn.dataset.id));
  });
  log.querySelectorAll('.call-item-check').forEach((cb, idx) => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', e => {
      const id = cb.dataset.id;
      if (e.shiftKey && lastClickedCallId) {
        const lastIdx = leadCalls.findIndex(x => x.id === lastClickedCallId);
        if (lastIdx !== -1) {
          const lo = Math.min(idx, lastIdx), hi = Math.max(idx, lastIdx);
          for (let i = lo; i <= hi; i++) selectedCalls.add(leadCalls[i].id);
          lastClickedCallId = id;
          paintCallSelection(log, leadCalls);
          return;
        }
      }
      lastClickedCallId = id;
      if (cb.checked) selectedCalls.add(id); else selectedCalls.delete(id);
      paintCallSelection(log, leadCalls);
    });
  });
  log.querySelectorAll('.call-select-all').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) leadCalls.forEach(c => selectedCalls.add(c.id));
    else leadCalls.forEach(c => selectedCalls.delete(c.id));
    paintCallSelection(log, leadCalls);
  }));
  document.getElementById('call-bulk-delete')?.addEventListener('click', async () => {
    const ids = [...selectedCalls];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} call${ids.length !== 1 ? 's' : ''} and their recordings? This can't be undone.`)) return;
    const sids = calls.filter(c => ids.includes(c.id) && c.recording_sid).map(c => c.recording_sid);
    calls = calls.filter(c => !ids.includes(c.id));
    selectedCalls.clear(); lastClickedCallId = null;
    renderCallLog();
    sids.forEach(sid => { const u = recUrlCache.get(sid); if (u) URL.revokeObjectURL(u); recUrlCache.delete(sid); });
    try { await Promise.all(ids.map(id => apiCall('DELETE', '/calls/' + id))); }
    catch (e) { toast('Some deletes failed'); }
  });
  document.getElementById('call-bulk-clear')?.addEventListener('click', () => {
    selectedCalls.clear(); lastClickedCallId = null; paintCallSelection(log, leadCalls);
  });
  wireCallStatusFilter(log);
}

function wireCallStatusFilter(log) {
  log.querySelectorAll('.tag-filter-pill[data-status]').forEach(el => {
    el.addEventListener('click', () => {
      activeCallStatus = el.dataset.status === activeCallStatus ? null : el.dataset.status;
      renderCallLog();
    });
  });
  log.querySelector('#call-status-clear')?.addEventListener('click', () => {
    activeCallStatus = null; renderCallLog();
  });
}

// Direct DOM patch for checkbox/select-all toggles, same reasoning as
// paintCallStar: ticking a box while listening to a recording shouldn't yank
// the audio, and a full rebuild would.
function paintCallSelection(log, leadCalls) {
  log.querySelectorAll('.call-item-check').forEach(cb => {
    const on = selectedCalls.has(cb.dataset.id);
    cb.checked = on;
    cb.closest('.call-item')?.classList.toggle('selected', on);
  });
  const anySelected = selectedCalls.size > 0;
  const allVisibleSelected = leadCalls.length > 0 && leadCalls.every(c => selectedCalls.has(c.id));
  const selectAllCb = log.querySelector('.call-select-all');
  if (selectAllCb) selectAllCb.checked = allVisibleSelected;
  const countEl = document.getElementById('call-bulk-count');
  if (countEl) { countEl.textContent = selectedCalls.size + ' selected'; countEl.classList.toggle('hidden', !anySelected); }
  document.getElementById('call-bulk-delete')?.classList.toggle('hidden', !anySelected);
  document.getElementById('call-bulk-clear')?.classList.toggle('hidden', !anySelected);
}

function paintCallStar(id, starred) {
  const item = document.querySelector(`.call-item[data-id="${id}"]`);
  const btn = document.querySelector(`.call-star-btn[data-star-id="${id}"]`);
  item?.classList.toggle('starred', !!starred);
  if (btn) {
    btn.classList.toggle('starred', !!starred);
    btn.textContent = starred ? '★' : '☆';
    btn.title = starred ? 'Unstar' : 'Star';
  }
}

async function toggleCallStar(id) {
  const c = calls.find(x => x.id === id);
  if (!c) return;
  const next = c.starred ? 0 : 1;
  c.starred = next; // optimistic
  paintCallStar(id, next); // direct DOM patch, not a full renderCallLog(): a
  // rebuild would yank a recording that's mid-playback
  try { await apiCall('PUT', '/calls/' + id, { starred: !!next }); }
  catch (e) { c.starred = next ? 0 : 1; toast('Could not save star'); paintCallStar(id, c.starred); }
}

let callNotesSaveTimer = null;
function saveCallNoteDebounced(id, notes) {
  const c = calls.find(x => x.id === id);
  if (c) c.notes = notes; // keep the in-memory model current so a later re-render doesn't stomp what's on screen
  clearTimeout(callNotesSaveTimer);
  callNotesSaveTimer = setTimeout(async () => {
    try { await apiCall('PUT', '/calls/' + id, { notes }); }
    catch (e) { toast('Could not save note'); }
  }, 600);
}

// Recordings sit behind auth, so a bare <audio src> can't load them — fetch
// with the Authorization header into a blob and play that. Cached per sid.
async function fetchRecordingUrl(sid) {
  if (recUrlCache.has(sid)) return recUrlCache.get(sid);
  const res = await fetch('/api/twilio/recording/' + sid, { headers: { 'Authorization': authHeader } });
  if (!res.ok) throw new Error('recording fetch failed');
  const url = URL.createObjectURL(await res.blob());
  recUrlCache.set(sid, url);
  return url;
}

async function playRecording(sid, btn) {
  const slot = document.getElementById('call-audio-' + sid);
  if (!slot) return;
  if (slot.querySelector('audio')) { slot.innerHTML = ''; return; } // toggle off
  btn.textContent = '…';
  try {
    const url = await fetchRecordingUrl(sid);
    slot.innerHTML = `<audio controls autoplay src="${url}"></audio>`;
  } catch(e) { toast('Could not load recording'); }
  btn.textContent = '▶';
}

async function downloadRecording(sid, num, ts) {
  try {
    const url = await fetchRecordingUrl(sid);
    const a = document.createElement('a');
    const d = new Date(ts || Date.now());
    const stamp = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    a.href = url; a.download = `call-${stamp}-${String(num||'').replace(/[^\d]/g,'')}.mp3`; a.click();
  } catch(e) { toast('Could not load recording'); }
}

// Deletes the whole call log entry — if it has a recording, that's deleted
// from Twilio permanently first (frees the storage cost), then the row
// itself disappears from the list.
async function deleteCall(callId) {
  if (!confirm('Delete this call and its recording? This cannot be undone.')) return;
  const call = calls.find(c => c.id === callId);
  const sid = call?.recording_sid;
  try {
    await apiCall('DELETE', '/calls/' + callId);
    if (sid) {
      const u = recUrlCache.get(sid); if (u) URL.revokeObjectURL(u); recUrlCache.delete(sid);
    }
    calls = calls.filter(c => c.id !== callId);
    renderCallLog();
    toast('Call deleted');
  } catch(e) { toast('Could not delete — check connection'); }
}

// ── SMS (Texts, Dialer tab) ──────────────────────────────────────────────
// Read-only log — replying happens from Raffi's personal cell (the Twilio
// number can't send until it's A2P 10DLC-registered), so there's no composer.
function smsDisplayName(s) {
  return s.lead_id ? (leads.find(l => l.id === s.lead_id)?.business_name || null) : null;
}

function renderSmsLog() {
  const log = document.getElementById('sms-log');
  if (!log) return;
  const inCrm = dialerInCrm();
  const scoped = inCrm && currentLeadId ? smsMessages.filter(s => s.lead_id === currentLeadId) : smsMessages;
  if (!scoped.length) {
    log.innerHTML = `<div class="agenda-empty">${inCrm ? 'No texts with this lead yet' : 'No texts yet'}</div>`;
    return;
  }
  log.innerHTML = '<div class="agenda-section-label">Texts</div>' + scoped.map(s => {
    const inbound = s.direction === 'inbound';
    const num = inbound ? s.from_number : s.to_number;
    const chipName = !inCrm ? smsDisplayName(s) : null;
    const failed = s.status === 'failed' || s.status === 'undelivered';
    return `<div class="call-item" data-id="${s.id}">
      <div class="call-item-header">
        <div class="call-item-id">
          ${chipName ? `<div class="call-item-name">${escHtml(chipName)}</div>` : ''}
          <div class="call-item-number"><span class="${inbound ? 'call-dir-in' : 'call-dir-out'}" title="${inbound ? 'Received' : 'Sent'}">${inbound ? '↙' : '↗'}</span> ${escHtml(fmtPhone(num))}</div>
        </div>
      </div>
      <div class="call-item-meta">
        <span class="agenda-time agenda-time-neutral">${escHtml(fmtFireTime(s.created_at))}</span>
        ${!inbound ? `<span class="call-status ${failed ? 'call-status-bad' : 'call-status-dim'}">${escHtml(s.status)}</span>` : ''}
      </div>
      <div class="sms-body">${escHtml(s.body)}</div>
    </div>`;
  }).join('');
}

// ── Push notifications setup ──
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  // Fetch the key BEFORE touching the existing subscription so an offline/
  // failed fetch can't destroy a working subscription (review catch).
  const { key } = await apiFetch('GET', '/push/vapid-key');
  // Discard any existing subscription before subscribing — subscribe() is NOT
  // idempotent: with one already present the browser hands back the same
  // (possibly dead) cached subscription instead of negotiating a fresh
  // endpoint. This exact gap kept a 403-dead Android subscription
  // re-registering itself forever.
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await apiCall('POST', '/push/subscribe', sub.toJSON());
}

// The button never hides while permission is granted: a local subscription
// existing says nothing about whether the push service still honors it, so
// there must always be a one-tap way to force a real resubscribe. It only
// hides on unsupported browsers or a hard permission denial.
async function updateNotifsButton() {
  const btn = document.getElementById('enable-notifs-btn');
  if (!btn) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)
      || Notification.permission === 'denied') {
    btn.classList.add('hidden'); return;
  }
  let subscribed = false;
  if (Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      subscribed = !!(await reg.pushManager.getSubscription());
    } catch(e) {}
  }
  btn.textContent = subscribed ? '🔄 Refresh notifications' : '🔔 Enable notifications';
  btn.classList.remove('hidden');
}

async function enableNotifications() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications blocked — allow them in browser settings'); return; }
    await subscribePush();
    toast('Notifications enabled on this device');
  } catch(e) {
    console.warn('push subscribe failed:', e);
    toast(String(e.message || '').includes('not configured')
      ? 'Push not set up on the server yet' : 'Could not enable notifications');
  }
  updateNotifsButton();
}

// Keep the server's subscription row fresh on every app open (endpoints rotate).
// Self-heal: browsers occasionally kill a push subscription without telling the
// page (desktop went silent exactly this way) — permission still granted but
// getSubscription() null. Re-subscribe instead of silently doing nothing.
async function refreshPushSubscription() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await apiFetch('POST', '/push/subscribe', sub.toJSON());
    else await subscribePush();
    updateNotifsButton();
  } catch(e) { console.warn('push subscription refresh failed:', e); }
}

// ── Chase CSV Import ───────────────────────────────────────────

function toTitleCase(str) {
  const minors = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of']);
  return str.toLowerCase().replace(/\w+/g, (w, i) =>
    (i === 0 || !minors.has(w)) ? w[0].toUpperCase() + w.slice(1) : w
  );
}

function cleanChaseCheckingPayee(desc) {
  const d = desc.trim();
  const merchants = [
    [/^(POS DEBIT\s+)?SMART AND FINAL/i, 'Smart and Final'],
    [/^(POS DEBIT\s+)?HYE MARKET/i, 'Hye Market'],
    [/^COSTCO WHSE/i, 'Costco'],
    [/^COSTCO GAS/i, 'Costco Gas'],
    [/^TRADER JOE/i, "Trader Joe's"],
    [/^JONS MARKETPLACE|^JONS MARKET #/i, "Jon's Marketplace"],
    [/^SUPER KING MKT/i, 'Super King Market'],
    [/^TACO BELL/i, 'Taco Bell'],
    [/^COFFEE BEAN/i, 'Coffee Bean & Tea'],
    [/^STARBUCKS/i, 'Starbucks'],
    [/^KRISPY KREME/i, 'Krispy Kreme'],
    [/^RALPHS/i, 'Ralphs'],
    [/^VONS/i, 'Vons'],
    [/^WHOLEFDS|^WHOLE FOODS/i, 'Whole Foods'],
    [/^LOTTE MARKET/i, 'Lotte Market'],
    [/^GOLDEN FARMS/i, 'Golden Farms Market'],
    [/^PACIFIC COAST G/i, 'Pacific Coast Grocer'],
    [/^OCEAN WHOLESALE/i, 'Ocean Wholesale Grocery'],
    [/^CONTINENTAL GOURMET/i, 'Continental Gourmet'],
    [/^TARGET\s/i, 'Target'],
    [/^MARSHALLS/i, 'Marshalls'],
    [/^ROSS STORES/i, 'Ross'],
    [/^MACY'?S/i, "Macy's"],
    [/^WAL.MART|^WALMART/i, 'Walmart'],
    [/^DOLLAR KING/i, 'Dollar King'],
    [/^WESTLAKE HARDWARE/i, 'Westlake Hardware'],
    [/^LOWE'?S/i, "Lowe's"],
    [/^THE HOME DEPOT/i, 'Home Depot'],
    [/^WALGREENS/i, 'Walgreens'],
    [/^PLANET FITNESS/i, 'Planet Fitness'],
    [/^COSTLESS/i, 'Costless Liquidation'],
    [/^ARCO\s/i, 'Arco'],
    [/^ATM WITHDRAWAL/i, 'ATM Withdrawal'],
    [/^NON-CHASE ATM FEE/i, 'Non-Chase ATM Fee'],
    [/^NON-CHASE ATM WITHDRAW/i, 'Non-Chase ATM Withdrawal'],
    [/^AMZ\*/i, 'Amazon'],
    [/^AMAZON MKTPL/i, 'Amazon'],
    [/^AMAZON MKTPLACE/i, 'Amazon'],
    [/^Amazon(\.com)?\*/i, 'Amazon'],
    [/^PAYPAL \*ETSY/i, 'Etsy'],
    [/^PAYPAL \*(E ?BAY|EBAY)/i, 'eBay'],
    [/^PAYPAL \*GOG/i, 'GOG'],
    [/^OPENAI/i, 'OpenAI'],
    [/^Close CRM/i, 'Close CRM'],
    [/^SoCalGas/i, 'SoCalGas'],
    [/^CITY OF GLENDALE/i, 'City of Glendale'],
    [/^GLENDALE.+GWP/i, 'Glendale Water & Power'],
    [/^Kemper Auto/i, 'Kemper Auto Insurance'],
    [/^ACI HMF|^HMF\s/i, 'HMF Car Payment'],
    [/^UNITRW\.CO/i, 'UnitRW Health'],
    [/^SQ \*SAINT MARY/i, "Saint Mary's Parking"],
    [/^WITHDRAWAL\s/i, 'Cash Withdrawal'],
    [/^USPS\s/i, 'USPS'],
    [/^HABIT\s/i, 'The Habit Burger'],
    [/^WHY NOT KABOB/i, 'Why Not Kabob'],
    [/^BROADWAY BURGER/i, 'Broadway Burger'],
    [/^SQ \*ARM GHARS|^ARM GHARS/i, 'Arm Ghars'],
    [/^PARADISE PASTRY/i, 'Paradise Pastry'],
    [/^UPTOWN COFFEE/i, 'Uptown Coffee'],
    [/^SLASH PIZZA/i, 'Slash Pizza'],
    [/^KISSAN INDIAN/i, 'Kissan Indian Cuisine'],
    [/^VAN NUYS AM STAR/i, 'AM Star Market'],
    [/^WestfieldFashion/i, 'Westfield Fashion Square'],
    [/^TABACCO WORLD|^TOBACCO WORLD/i, 'Tobacco World'],
    [/^CASTLE LIQUOR/i, 'Castle Liquor'],
    [/^EXPRESS CAR WASH/i, 'Express Car Wash'],
    [/^(PP\*)?GUSSWORLDFAMOUS/i, "Guss' World Famous"],
    [/^SPO\*CLUCK/i, 'Cluck & Smash'],
    [/^PY \*EPICURUS/i, 'Epicurus Gourmet'],
    [/^REMOTE ONLINE DEPOSIT/i, 'Remote Deposit'],
    [/^MINT MOBILE/i, 'Mint Mobile'],
    [/^NORTH HOLLYWOOD/i, 'North Hollywood Market'],
    [/^COSTCO/i, 'Costco'],
    [/^SPORTING GOODS/i, 'Sporting Goods'],
  ];
  for (const [re, label] of merchants) {
    if (re.test(d)) return label;
  }
  if (/^Zelle payment to (.+?) JPM/i.test(d)) {
    const m = d.match(/^Zelle payment to (.+?) JPM/i);
    return `Zelle to ${toTitleCase(m[1])}`;
  }
  if (/^Payment to Chase card ending in (\d+)/i.test(d)) {
    const m = d.match(/ending in (\d+)/i);
    return `Chase Credit Card ...${m[1]}`;
  }
  if (/^Online Payment \d+ To ALS/i.test(d)) return 'ALS Loan Payment';
  if (/^CHECK (\d+)/i.test(d)) {
    const m = d.match(/^CHECK (\d+)/i);
    return `Check #${m[1].trim()}`;
  }
  if (/^PAYPAL \*/i.test(d)) {
    const m = d.match(/^PAYPAL \*([A-Z0-9]+)/i);
    return m ? `PayPal - ${m[1]}` : 'PayPal';
  }
  if (/^SQ \*/i.test(d)) {
    const m = d.match(/^SQ \*([A-Z'?][A-Z\s'?]+?)(?:\s{2,}|\s[A-Z]+\s+CA|$)/i);
    return m ? toTitleCase(m[1].trim()) : 'Square Purchase';
  }
  let clean = d
    .replace(/^POS DEBIT\s+/i, '')
    .replace(/\s+\d{2}\/\d{2}\s*.*$/, '')
    .replace(/\s+Purchase\s+\$[\d.]+.*$/i, '')
    .replace(/\s+(?:PPD|WEB|TEL|ACH)\s+ID:.*$/i, '')
    .replace(/\s{3,}[A-Z\s]{3,}\s{2,}[A-Z]{2}\s*$/, '')
    .replace(/\s+[A-Z]+\s+[A-Z]{2}\s*$/, '')
    .replace(/\s+#\d{4,}\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return toTitleCase(clean);
}

function autoCheckingCategory(desc, type) {
  const d = desc.toUpperCase();
  if (/SMART AND FINAL|HYE MARKET|COSTCO WHSE|TRADER JOE|JONS MARKETPLACE|JONS MARKET #|SUPER KING|RALPHS|VONS|WHOLEFDS|LOTTE MARKET|GOLDEN FARMS|OCEAN WHOLESALE|PACIFIC COAST G|CONTINENTAL GOURMET|NORTH HOLLYWOOD MARKET/.test(d)) return 'Groceries';
  if (/TACO BELL|COFFEE BEAN|STARBUCKS|KRISPY KREME|SLASH PIZZA|BROADWAY BURGER|HABIT |ARM GHARS|WHY NOT KABOB|PARADISE PASTRY|UPTOWN COFFEE|KISSAN INDIAN|GUSS WORLD|CLUCK.SMASH|EPICURUS|SPO\*CLUCK/.test(d)) return 'Dining';
  if (/COSTCO GAS|ARCO /.test(d)) return 'Gas';
  if (/ATM WITHDRAWAL|NON-CHASE ATM|WITHDRAWAL /.test(d)) return 'Cash / ATM';
  if (/PAYMENT TO CHASE CARD/.test(d)) return 'Credit Card Payment';
  if (/ONLINE PAYMENT.*ALS/.test(d)) return 'Loan Payment';
  if (/(ACI )?HMF\s/.test(d) || /HMFUSA/.test(d)) return 'Car Payment';
  if (/KEMPER AUTO/.test(d)) return 'Auto Insurance';
  if (/SOCALGAS|CITY OF GLENDALE|GLENDALE.GWP/.test(d)) return 'Utilities';
  if (/OPENAI|CLOSE CRM/.test(d)) return 'Software';
  if (/PLANET FITNESS/.test(d)) return 'Fitness';
  if (/WALGREENS|UNITRW/.test(d)) return 'Health';
  if (type === 'CHECK_PAID') return 'Check';
  if (/TABACCO|TOBACCO|CASTLE LIQUOR/.test(d)) return 'Personal';
  if (/PARKING|SAINT MARY.S PARKIN/.test(d)) return 'Parking';
  if (/USPS/.test(d)) return 'Postage';
  if (/MINT MOBILE/.test(d)) return 'Phone';
  if (/CAR WASH/.test(d)) return 'Auto';
  if (/SPORTING GOODS/.test(d)) return 'Shopping';
  if (/TARGET|MARSHALLS|ROSS STORES|MACY|WAL.MART|WALMART|DOLLAR KING|WESTLAKE HARDWARE|LOWE.S|HOME DEPOT|AMAZON|PAYPAL|AMZ\*|COSTLESS|EBAY/.test(d)) return 'Shopping';
  return '';
}

function cleanChaseCreditPayee(desc) {
  const d = desc.trim();
  if (/^Amazon(\.com)?\*/i.test(d)) return 'Amazon';
  if (/^AMAZON/i.test(d)) return 'Amazon';
  if (/^TST\*/i.test(d)) return d.replace(/^TST\*/i, '').trim();
  if (/^SP /i.test(d)) return d.replace(/^SP /i, '').trim();
  if (/^FP \*/i.test(d)) return d.replace(/^FP \*/i, '').trim();
  if (/^AMZ\*/i.test(d)) return 'Amazon';
  if (/^LINODE \. AKAMAI/i.test(d)) return 'Linode / Akamai';
  if (/^PURCHASE INTEREST CHARGE/i.test(d)) return 'Chase Interest Charge';
  if (/^FOREIGN TRANSACTION FEE/i.test(d)) return 'Foreign Transaction Fee';
  if (/^GOOGLE \*/i.test(d)) { const m = d.match(/^GOOGLE \*(.+?)(?:_|\s|$)/i); return m ? `Google - ${m[1]}` : 'Google'; }
  if (/^ANTHROPIC$/i.test(d)) return 'Anthropic';
  if (/^CLOUDFLARE$/i.test(d)) return 'Cloudflare';
  if (/^INSTANTLY$/i.test(d)) return 'Instantly';
  if (/^Spectrum$/i.test(d)) return 'Spectrum';
  if (/^MINT MOBILE/i.test(d)) return 'Mint Mobile';
  if (/^Tesla Insurance/i.test(d)) return 'Tesla Insurance';
  if (/^CCV\*/i.test(d)) return d.replace(/^CCV\*/i, '').trim();
  if (/^OUTSCRAPER/i.test(d)) return 'Outscraper';
  if (/^PROFRESULTS/i.test(d)) return 'ProResults';
  if (/^KLM AIRLINE/i.test(d)) return 'KLM Airlines';
  if (/^MS\* BILDERBERG/i.test(d)) return 'Bilderberg Hotel';
  if (/^EXPEDIA/i.test(d)) return 'Expedia';
  if (/^VIRGINATLAIR/i.test(d)) return 'Virgin Atlantic';
  if (/^NLOV/i.test(d)) return 'Travel Purchase';
  return d;
}

function mapChaseCreditCategory(cat) {
  return { 'Food & Drink': 'Dining', 'Groceries': 'Groceries', 'Shopping': 'Shopping',
    'Bills & Utilities': 'Utilities', 'Travel': 'Travel', 'Professional Services': 'Professional',
    'Fees & Adjustments': 'Fees', 'Personal': 'Personal', 'Health & Wellness': 'Health' }[cat] || cat || '';
}

function autoCreditCategory(desc, cat) {
  const d = desc.toUpperCase();
  const mapped = mapChaseCreditCategory(cat);
  if (/ANTHROPIC|CLOUDFLARE|OPENAI|LINODE|GOOGLE \*WORKSPACE|INSTANTLY/.test(d)) return 'Software';
  if (/TESLA INSURANCE/.test(d)) return 'Auto Insurance';
  if (/MINT MOBILE/.test(d)) return 'Phone';
  if (/PURCHASE INTEREST CHARGE|FOREIGN TRANSACTION FEE/.test(d)) return 'Fees';
  return mapped;
}

function mdyToIsoDate(mdy) {
  const [m, d, y] = mdy.split('/');
  if (!m || !d || !y) return '';
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function parseChaseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { format: 'unknown', rows: [] };
  function parseLine(line) {
    const fields = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { fields.push(cur); cur = ''; }
      else cur += line[i];
    }
    fields.push(cur); return fields;
  }
  const header = parseLine(lines[0]).map(h => h.trim().toLowerCase());
  const isCredit   = header[0] === 'transaction date';
  const isChecking = header[0] === 'details';
  if (!isCredit && !isChecking) return { format: 'unknown', rows: [] };
  const format = isCredit ? 'credit' : 'checking';
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseLine(lines[i]);
    if (!f.length || !f[0]?.trim()) continue;
    if (isChecking) {
      const details  = f[0]?.trim();
      const postDate = f[1]?.trim();
      const desc     = f[2]?.trim() || '';
      const amount   = parseFloat(f[3]);
      const type     = f[4]?.trim() || '';
      if (type === 'ACCT_XFER') continue; // internal transfer between your own accounts, not real income/spend
      if (!postDate || isNaN(amount)) continue;
      rows.push({ date: mdyToIsoDate(postDate), amount: Math.abs(amount),
        payee: cleanChaseCheckingPayee(desc), category: autoCheckingCategory(desc, type),
        source: 'Chase Debit', direction: amount < 0 ? 'withdrawal' : 'deposit', note: '' });
    } else {
      const txDate = f[0]?.trim();
      const desc   = f[2]?.trim() || '';
      const chaseCat = f[3]?.trim() || '';
      const type   = f[4]?.trim() || '';
      const amount = parseFloat(f[5]);
      if (type === 'Payment') continue; // card payment already captured as a checking-side withdrawal
      if (!txDate || isNaN(amount)) continue;
      rows.push({ date: mdyToIsoDate(txDate), amount: Math.abs(amount),
        payee: cleanChaseCreditPayee(desc), category: autoCreditCategory(desc, chaseCat),
        source: 'Chase Credit', direction: amount < 0 ? 'withdrawal' : 'deposit', note: '' });
    }
  }
  return { format, rows };
}

let chaseImportPending = null;

function openChaseImportPreview(rows, format) {
  chaseImportPending = rows;
  const modal   = document.getElementById('chase-import-modal');
  const label   = document.getElementById('chase-import-label');
  const preview = document.getElementById('chase-import-preview');
  const withdrawals = rows.filter(r => r.direction === 'withdrawal').reduce((s, r) => s + r.amount, 0);
  const deposits     = rows.filter(r => r.direction === 'deposit').reduce((s, r) => s + r.amount, 0);
  const byCat   = {};
  rows.filter(r => r.direction === 'withdrawal').forEach(r => { const k = r.category || 'Uncategorized'; byCat[k] = (byCat[k] || 0) + r.amount; });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `<div class="chase-preview-cat"><span>${escHtml(cat)}</span><span>${escHtml(fmtAmount(amt))}</span></div>`)
    .join('');
  label.textContent = `Import: ${format === 'credit' ? 'Chase Credit Card' : 'Chase Checking'}`;
  preview.innerHTML = `
    <div class="chase-preview-meta">
      <span>${rows.length} transactions</span>
      <span class="chase-preview-total">−${escHtml(fmtAmount(withdrawals))} / +${escHtml(fmtAmount(deposits))}</span>
    </div>
    <div class="chase-preview-cats">${catRows}</div>`;
  modal.classList.remove('hidden');
}

async function confirmChaseImport() {
  if (!chaseImportPending?.length) return;
  const rows = chaseImportPending;
  chaseImportPending = null;
  document.getElementById('chase-import-modal').classList.add('hidden');
  const csvField = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['date,amount,category,payee,source,direction,note'];
  for (const r of rows) lines.push([r.date, r.amount, r.category, r.payee, r.source, r.direction, r.note].map(csvField).join(','));
  try {
    const result = await apiCall('POST', '/expenses/import', { csv: lines.join('\n') });
    const newCats = [...new Set(rows.map(r => r.category).filter(Boolean))];
    for (const name of newCats) {
      if (!expenseCategories.find(c => c.name === name)) {
        try { const cat = await apiCall('POST', '/expense-categories', { name }); expenseCategories.push(cat); } catch(e) {}
      }
    }
    toast(`Imported ${result.imported} expenses from Chase`);
    await loadExpenses();
  } catch(e) { toast('Import failed'); }
}

async function handleExpenseImport(file) {
  const text = await file.text();
  const { format, rows } = parseChaseCSV(text);
  if (format !== 'unknown') {
    if (!rows.length) { toast('No transactions found in this file'); return; }
    openChaseImportPreview(rows, format);
  } else {
    try {
      const r = await apiCall('POST', '/expenses/import', { csv: text });
      toast(`Imported ${r.imported} expenses`);
      await loadExpenses();
    } catch(e) { toast('Import failed'); }
  }
}

// ── Note editor ────────────────────────────────────────────────
async function openNote(id) {
  currentNoteId = id;
  let note = notesFullCache[id] || await idbGet('notes', id);
  if (!note) { try { note = await apiFetch('GET', '/notes/'+id); await idbPut('notes', note); } catch(e) { return; } }
  notesFullCache[id] = note;
  if (navigator.onLine) {
    apiFetch('GET', '/notes/'+id).then(n => {
      idbPut('notes', n); notesFullCache[n.id] = n;
      if (currentNoteId === id) {
        const ti = document.getElementById('editor-title');
        if (ti && ti.value !== n.title) ti.value = n.title;
        if (noteEditor && WEditor.getText(noteEditor) !== n.content)
          WEditor.setText(noteEditor, n.content);
      }
    }).catch(()=>{});
  }
  renderNotesList(); renderEditor(note);
  if (isMobile()) closeSidebar();
}

function renderToc() {
  const tocEl = document.getElementById('note-toc');
  const resizeHandle = document.getElementById('toc-resize-handle');
  const toggleBtn = document.getElementById('toc-bar-btn');
  if (!tocEl || !noteEditor) return;
  const doc = noteEditor.state.doc;
  const headings = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(#{1,6}) (.+)/);
    if (m) headings.push({ level: m[1].length, text: m[2].replace(/\{#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s+([^}\n]+)\}/g, '$1').replace(/[*_`~[\]]/g, ''), pos: line.from });
  }
  if (!headings.length) {
    tocEl.innerHTML = ''; tocEl.style.display = 'none';
    if (resizeHandle) resizeHandle.style.display = 'none';
    if (toggleBtn) toggleBtn.style.display = 'none';
    return;
  }
  if (toggleBtn) toggleBtn.style.display = '';
  const tocHidden = localStorage.getItem('toc-hidden') === '1';
  if (tocHidden) {
    tocEl.style.display = 'none';
    if (resizeHandle) resizeHandle.style.display = 'none';
    if (toggleBtn) toggleBtn.classList.remove('active');
  } else {
    tocEl.style.display = '';
    if (resizeHandle) resizeHandle.style.display = '';
    if (toggleBtn) toggleBtn.classList.add('active');
  }
  tocEl.innerHTML = headings.map(h =>
    `<div class="toc-item toc-h${h.level}" data-pos="${h.pos}" title="${escHtml(h.text)}">${escHtml(h.text)}</div>`
  ).join('');
  tocEl.querySelectorAll('.toc-item').forEach(el => {
    el.addEventListener('click', () => WEditor.scrollTo(noteEditor, parseInt(el.dataset.pos)));
  });
}
function tocDebounced() { clearTimeout(tocTimer); tocTimer = setTimeout(renderToc, 400); }

function setupTocResize() {
  const handle = document.getElementById('toc-resize-handle');
  const toc = document.getElementById('note-toc');
  if (!handle || !toc) return;
  const saved = localStorage.getItem('toc-width');
  if (saved) toc.style.width = saved + 'px';
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX, startW = toc.offsetWidth;
    const onMove = mv => {
      const newW = Math.max(80, Math.min(500, startW + (startX - mv.clientX)));
      toc.style.width = newW + 'px';
      localStorage.setItem('toc-width', newW);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Renames a tag everywhere it appears — notes AND tasks share one namespace.
async function renameTagGlobally(oldName, newName) {
  if (!newName || newName === oldName) return;
  const colors = JSON.parse(localStorage.getItem('tag-colors') || '{}');
  if (colors[oldName]) { colors[newName] = colors[oldName]; delete colors[oldName]; }
  localStorage.setItem('tag-colors', JSON.stringify(colors));

  const allIDB = await idbGetAll('notes');
  allIDB.forEach(n => { if (!notesFullCache[n.id]) notesFullCache[n.id] = n; });
  const affected = Object.values(notesFullCache).filter(n => noteTags(n).includes(oldName));
  for (const n of affected) {
    n.tags = noteTags(n).map(t => t === oldName ? newName : t).join(',');
    n.updated_at = Date.now();
    await idbPut('notes', n);
    try { await apiCall('PUT', '/notes/'+n.id, { title: n.title, content: n.content || '', tags: n.tags }); } catch(e) {}
  }
  notes.forEach(n => {
    if (noteTags(n).includes(oldName)) n.tags = noteTags(n).map(t => t === oldName ? newName : t).join(',');
  });

  const renameList = list => list.includes(oldName) ? list.map(t => t === oldName ? newName : t).join(',') : null;
  const idbTasks = await idbGetAll('tasks');
  for (const t of idbTasks) {
    const merged = renameList(taskTags(t));
    if (merged === null) continue;
    t.tags = merged; t.updated_at = Date.now();
    await idbPut('tasks', t);
    try { await apiCall('PUT', '/tasks/'+t.id, { tags: t.tags }); } catch(e) {}
  }
  currentBoardData.forEach(col => col.tasks.forEach(t => {
    const merged = renameList(taskTags(t));
    if (merged !== null) t.tags = merged;
  }));
  if (modalTaskTags.includes(oldName)) modalTaskTags = modalTaskTags.map(t => t === oldName ? newName : t);
}

// Unions tag names across notes AND tasks (idb + in-memory) — one shared namespace.
async function allTagNames() {
  const all = new Set();
  notes.forEach(n => { const f = notesFullCache[n.id] || n; noteTags(f).forEach(t => all.add(t)); });
  (await idbGetAll('notes')).forEach(n => noteTags(n).forEach(t => all.add(t)));
  currentBoardData.forEach(col => col.tasks.forEach(t => taskTags(t).forEach(x => all.add(x))));
  (await idbGetAll('tasks')).forEach(t => taskTags(t).forEach(x => all.add(x)));
  return [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function addTagToNote(val) {
  val = (val || '').replace(/,/g, '').trim();
  if (!val) return false;
  const n = notesFullCache[currentNoteId];
  if (!n) return false;
  const tags = noteTags(n);
  if (tags.includes(val)) return false;
  n.tags = [...tags, val].join(',');
  renderTagEditor(); saveNoteDebounced(); renderTagsBar(); renderNotesList();
  return true;
}

function renderTagEditor() {
  const el = document.getElementById('tag-editor');
  if (!el || !currentNoteId) return;
  const note = notesFullCache[currentNoteId];
  const tags = noteTags(note);
  el.innerHTML = tags.map(t => {
    const c = tagColor(t);
    return `<span class="note-tag editable" style="--tag-c:${c}"><span class="tag-color-dot" data-tag="${escHtml(t)}" style="background:${c}" title="Change color"></span><span class="tag-name" data-tag="${escHtml(t)}" title="Double-click to rename">${escHtml(t)}</span><button class="tag-remove-btn" data-tag="${escHtml(t)}">×</button></span>`;
  }).join('') + `<span class="tag-add-wrap" id="tag-add-wrap"><input class="tag-input" id="tag-input" placeholder="tag" autocomplete="off"><button class="tag-add-btn" id="tag-add-btn" title="Pick an existing tag">+</button><div class="tag-dropdown" id="tag-dropdown" hidden></div></span>`;
  el.querySelectorAll('.tag-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = tagColor(dot.dataset.tag);
      inp.addEventListener('input', () => setTagColor(dot.dataset.tag, inp.value));
      inp.click();
    });
  });
  el.querySelectorAll('.tag-name').forEach(nameEl => {
    nameEl.addEventListener('dblclick', () => {
      const oldName = nameEl.dataset.tag;
      const inp = document.createElement('input');
      inp.className = 'tag-rename-input';
      inp.value = oldName;
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      const commit = async () => {
        const newName = inp.value.replace(/,/g, '').trim();
        await renameTagGlobally(oldName, newName || oldName);
        renderTagEditor(); renderTagsBar(); renderNotesList();
        renderTaskTagsBar(); renderKanban(); renderTaskTagEditor();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { renderTagEditor(); }
      });
      inp.addEventListener('blur', commit);
    });
  });
  el.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = notesFullCache[currentNoteId];
      if (!n) return;
      n.tags = noteTags(n).filter(t => t !== btn.dataset.tag).join(',');
      renderTagEditor(); saveNoteDebounced(); renderTagsBar(); renderNotesList();
    });
  });
  const input = document.getElementById('tag-input');
  const dropdown = document.getElementById('tag-dropdown');
  const addBtn = document.getElementById('tag-add-btn');

  let opts = [];        // current filtered tag names shown in the dropdown
  let activeIndex = -1; // which dropdown row is keyboard-highlighted (-1 = none, focus on input)

  const highlight = () => {
    dropdown?.querySelectorAll('.tag-dropdown-item').forEach((item, i) => {
      item.classList.toggle('active', i === activeIndex);
    });
    if (activeIndex >= 0) dropdown?.querySelectorAll('.tag-dropdown-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };

  // Build/refresh the dropdown of existing tags (filtered by what's typed, excluding ones already on the note).
  const renderDropdown = async () => {
    if (!dropdown) return;
    const applied = noteTags(notesFullCache[currentNoteId] || {});
    const q = (input?.value || '').trim().toLowerCase();
    const all = await allTagNames();
    opts = all.filter(t => !applied.includes(t) && t.toLowerCase().includes(q));
    activeIndex = -1;
    if (!opts.length) {
      dropdown.innerHTML = `<div class="tag-dropdown-empty">${q ? 'No matching tags' : 'No other tags yet'}</div>`;
      return;
    }
    dropdown.innerHTML = opts.map(t =>
      `<div class="tag-dropdown-item" data-tag="${escHtml(t)}"><span class="tag-color-dot" style="background:${tagColor(t)}"></span>${escHtml(t)}</div>`
    ).join('');
    dropdown.querySelectorAll('.tag-dropdown-item').forEach((item, i) => {
      item.addEventListener('mousedown', e => {  // mousedown beats the input blur
        e.preventDefault();
        addTagToNote(item.dataset.tag);
      });
      item.addEventListener('mousemove', () => { activeIndex = i; highlight(); });
    });
  };
  const openDropdown = () => { if (dropdown) { renderDropdown(); dropdown.hidden = false; } };
  const closeDropdown = () => { if (dropdown) { dropdown.hidden = true; activeIndex = -1; } };

  addBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (dropdown.hidden) { openDropdown(); input?.focus(); } else { closeDropdown(); }
  });
  input?.addEventListener('focus', openDropdown);
  input?.addEventListener('input', () => { if (dropdown?.hidden) openDropdown(); else renderDropdown(); });
  input?.addEventListener('keydown', e => {
    const open = dropdown && !dropdown.hidden;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openDropdown(); }
      if (opts.length) { activeIndex = (activeIndex + 1) % opts.length; highlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && opts.length) { activeIndex = (activeIndex <= 0 ? opts.length : activeIndex) - 1; highlight(); }
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (open && activeIndex >= 0 && opts[activeIndex]) { addTagToNote(opts[activeIndex]); return; }
      if (addTagToNote(e.target.value)) return;   // re-renders the whole editor
      e.target.value = '';                         // duplicate/empty: just clear
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });
  input?.addEventListener('blur', () => setTimeout(closeDropdown, 120));
}

// ── Task tags (shared namespace/colors with note tags — see tagColor,
// setTagColor, allTagNames, renameTagGlobally above) ──────────────
function taskTags(task) {
  return (task && task.tags ? task.tags : '').split(',').map(t => t.trim()).filter(Boolean);
}

function renderTaskTagsBar() {
  const bar = document.getElementById('task-tags-bar');
  if (!bar) return;
  const allTags = new Set();
  currentBoardData.forEach(col => col.tasks.forEach(t => taskTags(t).forEach(x => allTags.add(x))));
  if (!allTags.size) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = [...allTags].sort().map(t => {
    const c = tagColor(t);
    return `<span class="tag-filter-pill${t === activeTaskTag ? ' active' : ''}" data-tag="${escHtml(t)}" style="--tag-c:${c}">${escHtml(t)}</span>`;
  }).join('') + (activeTaskTag ? `<span class="tag-filter-clear" id="task-tag-clear">✕</span>` : '');
  bar.querySelectorAll('.tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      activeTaskTag = el.dataset.tag === activeTaskTag ? null : el.dataset.tag;
      renderTaskTagsBar(); renderKanban();
    });
  });
  document.getElementById('task-tag-clear')?.addEventListener('click', () => {
    activeTaskTag = null; renderTaskTagsBar(); renderKanban();
  });
}

function addTagToModal(val) {
  val = (val || '').replace(/,/g, '').trim();
  if (!val || modalTaskTags.includes(val)) return false;
  modalTaskTags = [...modalTaskTags, val];
  renderTaskTagEditor();
  return true;
}

function renderTaskTagEditor() {
  const el = document.getElementById('task-tag-editor');
  if (!el) return;
  el.innerHTML = modalTaskTags.map(t => {
    const c = tagColor(t);
    return `<span class="note-tag editable" style="--tag-c:${c}"><span class="tag-color-dot" data-tag="${escHtml(t)}" style="background:${c}" title="Change color"></span><span class="tag-name" data-tag="${escHtml(t)}" title="Double-click to rename">${escHtml(t)}</span><button class="tag-remove-btn" data-tag="${escHtml(t)}">×</button></span>`;
  }).join('') + `<span class="tag-add-wrap" id="task-tag-add-wrap"><input class="tag-input" id="task-tag-input" placeholder="tag" autocomplete="off"><button class="tag-add-btn" id="task-tag-add-btn" title="Pick an existing tag">+</button><div class="tag-dropdown" id="task-tag-dropdown" hidden></div></span>`;
  el.querySelectorAll('.tag-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = tagColor(dot.dataset.tag);
      inp.addEventListener('input', () => setTagColor(dot.dataset.tag, inp.value));
      inp.click();
    });
  });
  el.querySelectorAll('.tag-name').forEach(nameEl => {
    nameEl.addEventListener('dblclick', () => {
      const oldName = nameEl.dataset.tag;
      const inp = document.createElement('input');
      inp.className = 'tag-rename-input';
      inp.value = oldName;
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      const commit = async () => {
        const newName = inp.value.replace(/,/g, '').trim();
        await renameTagGlobally(oldName, newName || oldName);
        renderTaskTagEditor(); renderTaskTagsBar(); renderKanban();
        renderTagEditor(); renderTagsBar(); renderNotesList();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { renderTaskTagEditor(); }
      });
      inp.addEventListener('blur', commit);
    });
  });
  el.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modalTaskTags = modalTaskTags.filter(t => t !== btn.dataset.tag);
      renderTaskTagEditor();
    });
  });
  const input = document.getElementById('task-tag-input');
  const dropdown = document.getElementById('task-tag-dropdown');
  const addBtn = document.getElementById('task-tag-add-btn');

  let opts = [];
  let activeIndex = -1;

  const highlight = () => {
    dropdown?.querySelectorAll('.tag-dropdown-item').forEach((item, i) => {
      item.classList.toggle('active', i === activeIndex);
    });
    if (activeIndex >= 0) dropdown?.querySelectorAll('.tag-dropdown-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };

  const renderDropdown = async () => {
    if (!dropdown) return;
    const q = (input?.value || '').trim().toLowerCase();
    const all = await allTagNames();
    opts = all.filter(t => !modalTaskTags.includes(t) && t.toLowerCase().includes(q));
    activeIndex = -1;
    if (!opts.length) {
      dropdown.innerHTML = `<div class="tag-dropdown-empty">${q ? 'No matching tags' : 'No other tags yet'}</div>`;
      return;
    }
    dropdown.innerHTML = opts.map(t =>
      `<div class="tag-dropdown-item" data-tag="${escHtml(t)}"><span class="tag-color-dot" style="background:${tagColor(t)}"></span>${escHtml(t)}</div>`
    ).join('');
    dropdown.querySelectorAll('.tag-dropdown-item').forEach((item, i) => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        addTagToModal(item.dataset.tag);
      });
      item.addEventListener('mousemove', () => { activeIndex = i; highlight(); });
    });
  };
  const openDropdown = () => { if (dropdown) { renderDropdown(); dropdown.hidden = false; } };
  const closeDropdown = () => { if (dropdown) { dropdown.hidden = true; activeIndex = -1; } };

  addBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (dropdown.hidden) { openDropdown(); input?.focus(); } else { closeDropdown(); }
  });
  input?.addEventListener('focus', openDropdown);
  input?.addEventListener('input', () => { if (dropdown?.hidden) openDropdown(); else renderDropdown(); });
  input?.addEventListener('keydown', e => {
    const open = dropdown && !dropdown.hidden;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openDropdown(); }
      if (opts.length) { activeIndex = (activeIndex + 1) % opts.length; highlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && opts.length) { activeIndex = (activeIndex <= 0 ? opts.length : activeIndex) - 1; highlight(); }
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (open && activeIndex >= 0 && opts[activeIndex]) { addTagToModal(opts[activeIndex]); return; }
      if (addTagToModal(e.target.value)) return;
      e.target.value = '';
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });
  input?.addEventListener('blur', () => setTimeout(closeDropdown, 120));
}

function renderEditor(note) {
  const area = document.getElementById('note-editor-area');
  WEditor.destroy(noteEditor);
  noteEditor = null;
  area.innerHTML = `
    <div class="editor-toolbar">
      <input class="note-title-input" id="editor-title" value="${escHtml(note.title)}" placeholder="Untitled">
      <div class="tag-editor" id="tag-editor"></div>
      <button class="ins-table-btn tb-btn" id="ins-table-btn" title="Insert table"><span class="tb-icon">⊞</span><span class="tb-label">Table</span></button>
      <button class="ins-count-btn tb-btn" id="ins-count-btn" title="Insert tally counter"><span class="tb-icon">±</span><span class="tb-label">Count</span></button>
      <div class="color-btn-wrap">
        <button class="color-note-btn tb-btn" id="color-note-btn" title="Color selected text"><span class="tb-icon">🎨</span><span class="tb-label">Color</span></button>
        <div class="color-palette" id="color-palette" hidden></div>
      </div>
      <button class="share-note-btn tb-btn" id="share-note-btn" title="Share / export"><span class="tb-icon">↗</span><span class="tb-label">Share</span></button>
      <button class="del-note-btn tb-btn" id="del-note-btn" title="Archive note"><span class="tb-icon">🗄</span><span class="tb-label">Archive</span></button>
      <button class="toc-bar-btn" id="toc-bar-btn" title="Toggle outline" style="display:none">▤</button>
    </div>
    <div class="editor-body">
      <div id="note-cm-mount"></div>
      <div class="toc-resize-handle" id="toc-resize-handle" style="display:none"></div>
      <nav id="note-toc" class="note-toc" style="display:none"></nav>
    </div>
  `;
  noteEditor = WEditor.create(document.getElementById('note-cm-mount'), {
    doc: note.content || '',
    onChange: () => { saveNoteDebounced(); tocDebounced(); },
    tabIndent: true,
    uploadImage,
  });
  renderToc();
  setupTocResize();
  document.getElementById('toc-bar-btn')?.addEventListener('click', () => {
    localStorage.setItem('toc-hidden', localStorage.getItem('toc-hidden') === '1' ? '0' : '1');
    renderToc();
  });
  renderTagEditor();
  document.getElementById('ins-table-btn')?.addEventListener('click', () => WEditor.insertTable(noteEditor));
  document.getElementById('ins-count-btn')?.addEventListener('click', () => WEditor.insertCounter(noteEditor));
  setupColorPicker();
  document.getElementById('share-note-btn').addEventListener('click', shareCurrentNote);
  document.getElementById('editor-title').addEventListener('input', saveNoteDebounced);
  // Enter in the title drops you into the note body
  document.getElementById('editor-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); noteEditor?.focus(); }
  });
  document.getElementById('del-note-btn').addEventListener('click', archiveCurrentNote);
}

function saveNoteDebounced() { clearTimeout(saveNoteTimer); saveNoteTimer = setTimeout(saveCurrentNote, 600); }
async function saveCurrentNote() {
  if (!currentNoteId) return;
  const titleEl = document.getElementById('editor-title');
  if (!titleEl || !noteEditor) return;
  const title = titleEl.value || 'Untitled';
  const content = WEditor.getText(noteEditor);
  const tags = notesFullCache[currentNoteId]?.tags || '';
  const t = Date.now();
  if (notesFullCache[currentNoteId]) Object.assign(notesFullCache[currentNoteId], { title, content, updated_at: t });
  const idx = notes.findIndex(n => n.id === currentNoteId);
  if (idx >= 0) { notes[idx] = { ...notes[idx], title, updated_at: t }; renderNotesList(); }
  const full = await idbGet('notes', currentNoteId);
  if (full) await idbPut('notes', { ...full, title, content, tags, updated_at: t });
  try { const saved = await apiCall('PUT', '/notes/'+currentNoteId, { title, content, tags }); await idbPut('notes', saved); }
  catch(e) {}
}

// Curated swatch palette for the editor's color button (hex without #).
const NOTE_COLOR_SWATCHES = [
  'f87171', 'fb923c', 'fbbf24', 'facc15', '8ce870', '5fc83b',
  '34d399', '38bdf8', '60a5fa', 'a78bfa', 'f472b6', 'e5e5e5',
];
function setupColorPicker() {
  const btn = document.getElementById('color-note-btn');
  const palette = document.getElementById('color-palette');
  if (!btn || !palette) return;
  palette.innerHTML = NOTE_COLOR_SWATCHES.map(h =>
    `<button class="color-swatch" data-hex="${h}" style="background:#${h}" title="#${h}"></button>`
  ).join('') + `<label class="color-swatch-custom" title="Custom color"><input type="color" id="color-custom-input" value="#5fc83b">+</label>`;
  const close = () => { palette.hidden = true; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    palette.hidden = !palette.hidden;
  });
  palette.addEventListener('click', e => e.stopPropagation());
  palette.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      WEditor.applyColor(noteEditor, sw.dataset.hex);
      close();
    });
  });
  palette.querySelector('#color-custom-input')?.addEventListener('input', e => {
    WEditor.applyColor(noteEditor, e.target.value.replace('#', ''));
    close();
  });
  document.addEventListener('click', close);
}

function shareCurrentNote() {
  if (!currentNoteId) { toast('No note open'); return; }
  const note = notesFullCache[currentNoteId];
  if (!note) { toast('Note not loaded'); return; }
  const content = noteEditor ? WEditor.getText(noteEditor) : (note.content || '');
  const title = (document.getElementById('editor-title')?.value || note.title || 'Untitled').trim();
  const filename = title.replace(/[/\\?%*:|"<>]/g, '-') + '.md';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast('Saved as ' + filename);
}

async function archiveCurrentNote() {
  if (!currentNoteId) { toast('No note open'); return; }
  if (!confirm('Archive this note?')) return;
  const id = currentNoteId;
  notes = notes.filter(n => n.id !== id); delete notesFullCache[id];
  await idbDelete('notes', id); currentNoteId = null;
  WEditor.destroy(noteEditor); noteEditor = null;
  renderNotesList(); renderTagsBar(); // renderNotesList repopulates the empty-state grid
  try { await apiCall('POST', '/notes/'+id+'/archive'); } catch(e) {}
}

async function newNote() {
  const title = 'Untitled ' + new Date().toLocaleDateString();
  try {
    const note = await apiCall('POST', '/notes', { title, content: '' });
    notes.unshift({ id: note.id, title: note.title, updated_at: note.updated_at });
    notesFullCache[note.id] = note; await idbPut('notes', note);
    renderNotesList(); openNote(note.id);
  } catch(e) {
    const id = 'local_'+Date.now(), t = Date.now();
    const note = { id, title, content: '', tags: '', created_at: t, updated_at: t };
    notes.unshift({ id, title, updated_at: t }); notesFullCache[id] = note; await idbPut('notes', note);
    await queueForSync({ method:'POST', path:'/notes', body:{ title, content:'' } });
    renderNotesList(); openNote(id);
  }
}

async function importMdFiles(files) {
  const arr = [];
  for (const f of files) arr.push({ name: f.name, content: await f.text() });
  try { const r = await apiCall('POST', '/notes/import', { files: arr }); toast(`Imported ${r.imported} notes`); await fullSync(); }
  catch(e) { toast('Import failed — try again when online'); }
}

// ── Universal Search ───────────────────────────────────────────
// (The ⌘K command palette that used to live in this search dropdown was
// deleted outright in rfy-crm — confirmed unused. Search covers notes,
// boards, tasks, CRM leads, and dialer prospects.)
let searchFlat = [];
let searchIdx = -1;
let searchDebounce = null;

function closeSearch() {
  document.getElementById('search-dropdown').classList.add('hidden');
  document.getElementById('search-bar-wrap').classList.remove('mobile-open');
  searchIdx = -1;
}

function updateSearchSel() {
  document.querySelectorAll('#search-dropdown .search-item').forEach((el, i) => {
    el.classList.toggle('sel', i === searchIdx);
    if (i === searchIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

async function renderSearch(q) {
  const dropdown = document.getElementById('search-dropdown');
  const ql = q.toLowerCase().trim();
  if (!ql) { closeSearch(); return; }

  // Pre-fill note content cache from IDB
  const allIDB = await idbGetAll('notes');
  allIDB.forEach(n => { if (!notesFullCache[n.id]) notesFullCache[n.id] = n; });

  const noteResults = notes.filter(n => {
    if (n.title.toLowerCase().includes(ql)) return true;
    const f = notesFullCache[n.id];
    return f?.content?.toLowerCase().includes(ql);
  }).slice(0, 5);

  const boardResults = boards.filter(b => b.name.toLowerCase().includes(ql)).slice(0, 5);

  const allTasks = await idbGetAll('tasks');
  const colMap = Object.fromEntries(allColumns.map(c => [c.id, c]));
  const boardMap = Object.fromEntries(boards.map(b => [b.id, b]));
  const taskResults = allTasks.filter(t =>
    !t.deleted_at && (t.title.toLowerCase().includes(ql) || t.description?.toLowerCase().includes(ql))
  ).slice(0, 5);

  const prospectResults = allProspects.filter(p =>
    (p.name || '').toLowerCase().includes(ql) || (p.phone || '').includes(ql) || (p.city || '').toLowerCase().includes(ql)
  ).slice(0, 5);

  if (!leads.length) { try { leads = await apiCall('GET', '/leads'); } catch (e) {} }
  const leadResults = leads.filter(l =>
    (l.business_name || '').toLowerCase().includes(ql) || (l.website || '').toLowerCase().includes(ql) || (l.contact_name || '').toLowerCase().includes(ql)
  ).slice(0, 5);

  searchFlat = [
    ...noteResults.map(n => ({ type: 'note', data: n })),
    ...boardResults.map(b => ({ type: 'board', data: b })),
    ...taskResults.map(t => ({ type: 'task', data: t })),
    ...leadResults.map(l => ({ type: 'lead', data: l })),
    ...prospectResults.map(p => ({ type: 'prospect', data: p })),
  ];

  if (!searchFlat.length) {
    dropdown.innerHTML = `<div class="search-empty">No results</div>`;
    dropdown.classList.remove('hidden');
    return;
  }

  let html = '';
  let fi = 0;

  if (noteResults.length) {
    html += `<div class="search-section-header">Notes</div>`;
    for (const n of noteResults) {
      const f = notesFullCache[n.id];
      let snippet = '';
      if (f?.content) { const idx = f.content.toLowerCase().indexOf(ql); if (idx >= 0) snippet = '…' + f.content.slice(Math.max(0,idx-20),idx+60).replace(/\n/g,' ') + '…'; }
      html += `<div class="search-item" data-fi="${fi++}"><div class="search-item-body">
        <div class="search-item-title">${escHtml(n.title)}</div>
        ${snippet ? `<div class="search-item-sub">${escHtml(snippet)}</div>` : ''}
      </div></div>`;
    }
  }
  if (boardResults.length) {
    html += `<div class="search-section-header">Boards</div>`;
    for (const b of boardResults) {
      html += `<div class="search-item" data-fi="${fi++}"><div class="search-item-body">
        <div class="search-item-title">${escHtml(b.name)}</div>
      </div></div>`;
    }
  }
  if (taskResults.length) {
    html += `<div class="search-section-header">Projects</div>`;
    for (const t of taskResults) {
      const col = colMap[t.column_id];
      const board = col ? boardMap[col.board_id] : null;
      const sub = board ? `${board.name} · ${col.name}` : '';
      html += `<div class="search-item" data-fi="${fi++}"><div class="search-item-body">
        <div class="search-item-title">${escHtml(t.title)}</div>
        ${sub ? `<div class="search-item-sub">${escHtml(sub)}</div>` : ''}
      </div></div>`;
    }
  }
  if (leadResults.length) {
    html += `<div class="search-section-header">Leads</div>`;
    for (const l of leadResults) {
      html += `<div class="search-item" data-fi="${fi++}"><div class="search-item-body">
        <div class="search-item-title">${escHtml(l.business_name || 'Untitled lead')}</div>
        ${l.website ? `<div class="search-item-sub">${escHtml(l.website)}</div>` : ''}
      </div></div>`;
    }
  }
  if (prospectResults.length) {
    html += `<div class="search-section-header">Prospects</div>`;
    for (const p of prospectResults) {
      const listName = prospectLists.find(pl => pl.id === p.list_id)?.name || '';
      const sub = [fmtPhone(p.phone) || p.phone, listName].filter(Boolean).join(' · ');
      html += `<div class="search-item" data-fi="${fi++}"><div class="search-item-body">
        <div class="search-item-title">${escHtml(p.name || 'Unnamed')}</div>
        ${sub ? `<div class="search-item-sub">${escHtml(sub)}</div>` : ''}
      </div></div>`;
    }
  }
  searchIdx = -1;
  dropdown.innerHTML = html;
  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.search-item').forEach(el => {
    el.addEventListener('mouseenter', () => { searchIdx = parseInt(el.dataset.fi); updateSearchSel(); });
    el.addEventListener('click', () => activateSearch(parseInt(el.dataset.fi)));
  });
}

function activateSearch(idx) {
  const item = searchFlat[idx];
  if (!item) return;
  closeSearch();
  if (item.type === 'note') { switchTab('notes'); openNote(item.data.id); }
  else if (item.type === 'board') { switchTab('tasks'); selectBoard(item.data.id); }
  else if (item.type === 'task') {
    const col = allColumns.find(c => c.id === item.data.column_id);
    if (col) { switchTab('tasks'); selectBoard(col.board_id).then(() => openTaskModal(item.data)); }
  }
  else if (item.type === 'lead') { switchTab('crm'); openLead(item.data.id); }
  else if (item.type === 'prospect') {
    switchTab('dialer');
    openProspectList(item.data.list_id).then(() => flashProspectRow(item.data.id));
  }
}

// Jump straight to a prospect row after its list opens from search — scroll
// it into view and flash it so it's findable in a list of hundreds.
function flashProspectRow(id) {
  const row = document.querySelector(`.prospect-row[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('search-flash');
  setTimeout(() => row.classList.remove('search-flash'), 1800);
}

// ── Boards ─────────────────────────────────────────────────────
function renderBoardsBar() {
  const list = document.getElementById('boards-list');
  list.innerHTML = boards.map(b => `
    <div class="board-item${b.id===currentBoardId?' active':''}" draggable="true" data-bid="${b.id}">
      <span class="board-item-name">${escHtml(b.name)}</span>
      <button class="board-item-del" data-id="${b.id}" title="Archive board">🗄</button>
    </div>
  `).join('');
  list.querySelectorAll('.board-item').forEach(el => {
    el.addEventListener('click', () => { selectBoard(el.dataset.bid); if (isMobile()) closeSidebar(); });
    el.addEventListener('dblclick', e => { e.stopPropagation(); promptRenameBoard(el.dataset.bid); });
    el.addEventListener('dragstart', e => {
      dragBoardId = el.dataset.bid;
      e.dataTransfer.setData('board-drag', dragBoardId);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => el.classList.add('dragging'), 0);
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging', 'board-drop-above', 'board-drop-below'); dragBoardId = null; });
    el.addEventListener('dragover', e => {
      if (!Array.from(e.dataTransfer.types).includes('board-drag')) return;
      e.preventDefault();
      const mid = el.getBoundingClientRect().top + el.offsetHeight / 2;
      el.classList.toggle('board-drop-above', e.clientY < mid);
      el.classList.toggle('board-drop-below', e.clientY >= mid);
    });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('board-drop-above', 'board-drop-below'); });
    el.addEventListener('drop', e => {
      const insertBefore = el.classList.contains('board-drop-above');
      el.classList.remove('board-drop-above', 'board-drop-below');
      const fromId = e.dataTransfer.getData('board-drag');
      if (!fromId || fromId === el.dataset.bid) return;
      e.preventDefault(); reorderBoards(fromId, el.dataset.bid, insertBefore);
    });
  });
  list.querySelectorAll('.board-item-del').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); archiveBoard(el.dataset.id); }));
}

async function promptRenameBoard(id) {
  const board = boards.find(b => b.id === id);
  if (!board) return;
  const name = prompt('Rename board:', board.name);
  if (!name?.trim() || name.trim() === board.name) return;
  board.name = name.trim();
  renderBoardsBar();
  try { await apiCall('PUT', '/boards/' + id, { name: board.name }); } catch(e) { toast('Could not rename board'); }
}

async function archiveBoard(id) {
  const board = boards.find(b => b.id === id);
  if (!board || !confirm(`Archive board "${board.name}"?`)) return;
  boards = boards.filter(b => b.id !== id);
  if (currentBoardId === id) { currentBoardId = boards.length ? boards[0].id : null; currentBoardData = []; }
  await idbDelete('boards', id); renderBoardsBar();
  if (currentBoardId) await loadBoard(currentBoardId); else renderKanban();
  try { await apiCall('POST', '/boards/'+id+'/archive'); } catch(e) {}
}
async function deleteCurrentBoard() {
  if (!currentBoardId) { toast('No board selected'); return; }
  archiveBoard(currentBoardId);
}
async function selectBoard(id) {
  currentBoardId = id; selectedTasks.clear(); updateBulkActions(); activeTaskTag = null;
  mobileColIdx = 0; renderBoardsBar(); await loadBoard(id);
}
async function loadBoard(id) {
  try {
    currentBoardData = await apiFetch('GET', '/boards/'+id+'/columns');
    currentBoardData.forEach(col => { idbPut('columns', col); col.tasks.forEach(t => idbPut('tasks', t)); });
  } catch(e) { await loadBoardOffline(id); return; }
  renderKanban();
}
async function loadBoardOffline(id) {
  const allCols = await idbGetAll('columns'), allTasks = await idbGetAll('tasks');
  currentBoardData = allCols.filter(c => c.board_id===id).sort((a,b)=>a.position-b.position)
    .map(c => ({ ...c, tasks: allTasks.filter(t => t.column_id===c.id).sort((a,b)=>a.position-b.position) }));
  renderKanban();
}

// ── Mobile kanban nav ──────────────────────────────────────────
function updateMobileColNav() {
  const nav = document.getElementById('mobile-col-nav');
  if (!nav) return;
  const cols = nonTop3Cols();
  const show = isMobile() && cols.length > 0;
  nav.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const col = cols[mobileColIdx];
  const label = document.getElementById('col-nav-label');
  if (label && col) label.textContent = `${col.name}  ${mobileColIdx + 1}/${cols.length}`;
  const prevBtn = document.getElementById('prev-col-btn');
  const nextBtn = document.getElementById('next-col-btn');
  if (prevBtn) prevBtn.disabled = mobileColIdx === 0;
  if (nextBtn) nextBtn.disabled = mobileColIdx >= cols.length - 1;
}
function goToMobileCol(idx) {
  const cols = nonTop3Cols();
  if (!cols.length) return;
  mobileColIdx = Math.max(0, Math.min(idx, cols.length - 1));
  const board = document.getElementById('kanban-board');
  if (board) board.scrollLeft = mobileColIdx * board.clientWidth;
  updateMobileColNav();
}

// ── Kanban render ──────────────────────────────────────────────
// The Top 3 tray (kind='top3') is a real column server-side, but it's kept out
// of the horizontal column strip and rendered as its own pinned row instead.
function nonTop3Cols() { return currentBoardData.filter(c => c.kind !== 'top3'); }
function getTop3Col() { return currentBoardData.find(c => c.kind === 'top3'); }

function renderKanban() {
  const area = document.getElementById('kanban-area');
  renderTaskTagsBar();

  // Preserve horizontal scroll position across re-renders
  const prevBoard = area.querySelector('.kanban-board');
  const savedScrollLeft = prevBoard ? prevBoard.scrollLeft : 0;

  if (!currentBoardId || !boards.length) {
    area.innerHTML = `<div class="no-board-msg"><span>No board selected.</span><button id="first-board-btn">+ Create a board</button></div>`;
    document.getElementById('first-board-btn')?.addEventListener('click', promptNewBoard);
    return;
  }
  const cols = nonTop3Cols();
  if (!cols.length) {
    area.innerHTML = `<div class="no-board-msg"><span>No columns yet.</span><button id="first-col-btn">+ Add a column</button></div>`;
    document.getElementById('first-col-btn')?.addEventListener('click', promptNewColumn);
    return;
  }
  area.innerHTML = `<div class="kanban-outer"><div class="top3-tray" id="top3-tray"></div><div class="kanban-board" id="kanban-board"></div></div>`;
  const top3 = getTop3Col();
  if (top3) document.getElementById('top3-tray').appendChild(createTop3El(top3));

  const board = document.getElementById('kanban-board');
  cols.forEach(col => board.appendChild(createColEl(col)));
  const addCard = document.createElement('div');
  addCard.className = 'add-col-card'; addCard.textContent = '+ Add column';
  addCard.addEventListener('click', promptNewColumn);
  board.appendChild(addCard);

  if (savedScrollLeft) board.scrollLeft = savedScrollLeft;

  // Mobile scroll tracking → update nav label
  board.addEventListener('scroll', () => {
    if (!isMobile()) return;
    const colW = board.clientWidth;
    if (!colW) return;
    const idx = Math.round(board.scrollLeft / colW);
    if (idx !== mobileColIdx) { mobileColIdx = idx; updateMobileColNav(); }
  }, { passive: true });

  updateMobileColNav();
}

function isDoneCol(col) { return /\bdone\b/i.test(col.name); }

function createColEl(col) {
  const visibleTasks = activeTaskTag ? col.tasks.filter(t => taskTags(t).includes(activeTaskTag)) : col.tasks;
  const el = document.createElement('div');
  el.className = 'kanban-col' + (isDoneCol(col) ? ' col-done' : '');
  el.dataset.colId = col.id;
  el.setAttribute('draggable', 'true');

  el.innerHTML = `
    <div class="col-header">
      <input type="checkbox" class="col-select-all-cb" title="Select all in column">
      <span class="col-name" title="Click to rename">${escHtml(col.name)}</span>
      <span class="col-count">${visibleTasks.length}</span>
      <button class="icon-btn add-task-btn" title="Add task">+</button>
      <button class="col-delete-btn" title="Delete column">✕</button>
    </div>
    <div class="tasks-list" id="tasks-${col.id}" data-col-id="${col.id}"></div>
  `;

  el.querySelector('.add-task-btn').addEventListener('click', () => openNewTaskModal(col.id));
  el.querySelector('.col-delete-btn').addEventListener('click', async () => {
    if (!confirm(`Delete column "${col.name}" and all its tasks?`)) return;
    currentBoardData = currentBoardData.filter(c => c.id !== col.id);
    renderKanban(); await idbDelete('columns', col.id);
    try { await apiCall('DELETE', '/columns/'+col.id); } catch(e) {}
  });
  el.querySelector('.col-name').addEventListener('click', () => promptRenameCol(col));

  // Select-all checkbox for this column
  const selectAllCb = el.querySelector('.col-select-all-cb');
  selectAllCb.addEventListener('change', e => {
    e.stopPropagation();
    col.tasks.forEach(t => {
      if (e.target.checked) selectedTasks.add(t.id); else selectedTasks.delete(t.id);
    });
    el.querySelectorAll('.task-card').forEach((card, i) => {
      card.classList.toggle('selected', e.target.checked);
      const cb = card.querySelector('.task-select-cb');
      if (cb) cb.checked = e.target.checked;
    });
    selectAllCb.indeterminate = false;
    updateBulkActions();
  });

  // Column drag — from anywhere on the column (not task cards, which stopPropagation)
  el.addEventListener('dragstart', e => {
    if (e.target.closest('.task-card')) return;
    dragColId = col.id;
    e.dataTransfer.setData('col-drag', col.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('col-dragging'), 0);
  });
  el.addEventListener('dragend', () => { el.classList.remove('col-dragging','col-drop-left','col-drop-right'); dragColId = null; });
  el.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault();
    const mid = el.getBoundingClientRect().left + el.offsetWidth / 2;
    el.classList.toggle('col-drop-left', e.clientX < mid);
    el.classList.toggle('col-drop-right', e.clientX >= mid);
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('col-drop-left','col-drop-right'); });
  el.addEventListener('drop', e => {
    const insertBefore = el.classList.contains('col-drop-left');
    el.classList.remove('col-drop-left','col-drop-right');
    const fromId = e.dataTransfer.getData('col-drag');
    if (!fromId || fromId === col.id) return;
    e.preventDefault(); e.stopPropagation(); reorderColumns(fromId, col.id, insertBefore);
  });

  // Task drop zone (empty column or below all tasks)
  const tasksList = el.querySelector('.tasks-list');
  tasksList.addEventListener('dragover', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation(); tasksList.classList.add('drop-active');
  });
  tasksList.addEventListener('dragleave', e => { if (!tasksList.contains(e.relatedTarget)) tasksList.classList.remove('drop-active'); });
  tasksList.addEventListener('drop', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation(); tasksList.classList.remove('drop-active');
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) reorderTask(taskId, col.id, null, false);
  });

  visibleTasks.forEach(task => tasksList.appendChild(createTaskEl(task, col)));
  return el;
}

// Top 3 tray: same drag-in/drag-out/reorder mechanics as a real column
// (it IS one, kind='top3') — just rendered separately with bigger cards and
// no rename/delete controls. The 3-item cap is enforced centrally in reorderTask.
function createTop3El(col) {
  const visibleTasks = activeTaskTag ? col.tasks.filter(t => taskTags(t).includes(activeTaskTag)) : col.tasks;
  const el = document.createElement('div');
  el.className = 'top3-col';
  el.dataset.colId = col.id;
  el.innerHTML = `
    <div class="top3-header">
      <span class="top3-label">🔥 Top 3</span>
      <span class="top3-count">${col.tasks.length}/3</span>
      <button class="icon-btn add-task-btn" title="Add task">+</button>
    </div>
    <div class="top3-tasks" id="tasks-${col.id}" data-col-id="${col.id}"></div>
  `;
  el.querySelector('.add-task-btn').addEventListener('click', () => openNewTaskModal(col.id));

  const tasksList = el.querySelector('.top3-tasks');
  tasksList.addEventListener('dragover', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation(); tasksList.classList.add('drop-active');
  });
  tasksList.addEventListener('dragleave', e => { if (!tasksList.contains(e.relatedTarget)) tasksList.classList.remove('drop-active'); });
  tasksList.addEventListener('drop', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation(); tasksList.classList.remove('drop-active');
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) reorderTask(taskId, col.id, null, false);
  });

  visibleTasks.forEach(task => tasksList.appendChild(createTaskEl(task, col, true)));
  return el;
}

async function reorderColumns(fromId, toId, insertBefore) {
  const fi = currentBoardData.findIndex(c=>c.id===fromId), ti = currentBoardData.findIndex(c=>c.id===toId);
  if (fi<0||ti<0) return;
  const [moved] = currentBoardData.splice(fi,1);
  let insertIdx = currentBoardData.findIndex(c=>c.id===toId);
  if (!insertBefore) insertIdx++;
  currentBoardData.splice(insertIdx, 0, moved);
  currentBoardData.forEach((c,i) => c.position=i);
  renderKanban();
  for (let i=0;i<currentBoardData.length;i++) {
    const c=currentBoardData[i]; await idbPut('columns',c);
    try { await apiCall('PUT','/columns/'+c.id,{position:i}); } catch(e) {}
  }
}

async function reorderBoards(fromId, toId, insertBefore) {
  const fi = boards.findIndex(b=>b.id===fromId), ti = boards.findIndex(b=>b.id===toId);
  if (fi<0||ti<0) return;
  const [moved] = boards.splice(fi,1);
  let insertIdx = boards.findIndex(b=>b.id===toId);
  if (!insertBefore) insertIdx++;
  boards.splice(insertIdx, 0, moved);
  boards.forEach((b,i) => b.position=i);
  renderBoardsBar();
  for (let i=0;i<boards.length;i++) {
    const b=boards[i]; await idbPut('boards',b);
    try { await apiCall('PUT','/boards/'+b.id,{position:i}); } catch(e) {}
  }
}

async function reorderNotes(fromId, toId, insertBefore) {
  const fi = notes.findIndex(n=>n.id===fromId), ti = notes.findIndex(n=>n.id===toId);
  if (fi<0||ti<0) return;
  const [moved] = notes.splice(fi,1);
  let insertIdx = notes.findIndex(n=>n.id===toId);
  if (!insertBefore) insertIdx++;
  notes.splice(insertIdx, 0, moved);
  notes.forEach((n,i) => n.position=i);
  renderNotesList();
  for (let i=0;i<notes.length;i++) {
    const n=notes[i]; await idbPut('notes',n);
    try { await apiCall('PUT','/notes/'+n.id,{position:i}); } catch(e) {}
  }
}

async function reorderTask(taskId, targetColId, refTaskId, insertBefore) {
  const targetCol = currentBoardData.find(c => c.id === targetColId);
  if (!targetCol) return;
  if (targetCol.kind === 'top3' && targetCol.tasks.length >= 3 && !targetCol.tasks.some(t => t.id === taskId)) {
    toast('Top 3 is full — remove one first');
    return;
  }
  let movedTask = null;
  for (const c of currentBoardData) {
    const idx = c.tasks.findIndex(t => t.id === taskId);
    if (idx >= 0) { [movedTask] = c.tasks.splice(idx, 1); movedTask.column_id = targetColId; break; }
  }
  if (!movedTask) return;
  const refIdx = refTaskId ? targetCol.tasks.findIndex(t => t.id === refTaskId) : -1;
  const insertIdx = refIdx >= 0 ? (insertBefore ? refIdx : refIdx + 1) : targetCol.tasks.length;
  targetCol.tasks.splice(insertIdx, 0, movedTask);
  targetCol.tasks.forEach((t, i) => t.position = i);
  renderKanban();
  for (let i = 0; i < targetCol.tasks.length; i++) {
    const t = targetCol.tasks[i];
    await idbPut('tasks', t);
    try { await apiCall('PUT', '/tasks/'+t.id, { column_id: t.column_id, position: i }); } catch(e) {}
  }
}

function countTaskChecks(desc) {
  if (!desc) return null;
  const total = (desc.match(/\[[ xX]\]/g) || []).length;
  if (!total) return null;
  const done = (desc.match(/\[[xX]\]/g) || []).length;
  return { total, done };
}

function taskDescPreview(desc) {
  if (!desc?.trim()) return '';
  return desc.split('\n')
    .filter(l => !/^!\[/.test(l.trim())) // skip image lines
    .map(l => l.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '').replace(/\{#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s+([^}\n]+)\}/g, '$1').replace(/\*\*|__|\*|_|~~|`/g, '').trim())
    .find(l => l.length > 0)?.slice(0, 80) || '';
}


async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Authorization': authHeader }, body: fd });
  const data = await res.json();
  if (!data.url) throw new Error('Upload failed');
  return data.url;
}

function createTaskEl(task, col, isTop3) {
  const inDone = isDoneCol(col);
  const el = document.createElement('div');
  el.className = 'task-card' + (isTop3 ? ' task-card-top3' : '') + (selectedTasks.has(task.id) ? ' selected' : '');
  el.dataset.taskId = task.id;
  el.setAttribute('draggable', 'true');
  const checks = countTaskChecks(task.description);
  const preview = taskDescPreview(task.description);
  const hasDesc = !!(task.description?.trim());
  const tags = taskTags(task);
  el.innerHTML = `
    <div class="task-card-header">
      <input type="checkbox" class="task-select-cb" ${selectedTasks.has(task.id)?'checked':''}>
      <span class="task-title">${escHtml(task.title)}</span>
      ${hasDesc ? `<span class="task-desc-dot" title="Has description"></span>` : ''}
      <button class="task-claude-btn${task.claude_marked ? ' active' : ''}" title="Mark for Claude Code">${CLAUDE_ICON_SVG}</button>
      <button class="task-done-btn" title="${inDone ? 'Already done' : 'Mark as done'}">✓</button>
    </div>
    ${tags.length ? `<div class="note-item-tags">${tags.map(t=>`<span class="note-tag" style="--tag-c:${tagColor(t)}">${escHtml(t)}</span>`).join('')}</div>` : ''}
    ${preview ? `<div class="task-desc-preview">${escHtml(preview)}</div>` : ''}
    ${checks ? `<div class="task-checklist-preview"><span class="task-checks-done">${checks.done}</span><span class="task-checks-sep">/</span><span class="task-checks-total">${checks.total}</span></div>` : ''}
  `;
  el.querySelector('.task-select-cb').addEventListener('change', e => {
    e.stopPropagation();
    if(e.target.checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);
    el.classList.toggle('selected', e.target.checked); updateBulkActions();
    // Sync col select-all checkbox
    const colEl = document.querySelector(`.kanban-col[data-col-id="${col.id}"]`);
    const allCb = colEl?.querySelector('.col-select-all-cb');
    if (allCb) {
      const allSel = col.tasks.every(t => selectedTasks.has(t.id));
      const noneSel = col.tasks.every(t => !selectedTasks.has(t.id));
      allCb.checked = allSel;
      allCb.indeterminate = !allSel && !noneSel;
    }
  });
  el.querySelector('.task-done-btn').addEventListener('click', e => { e.stopPropagation(); if(!inDone) markTaskDone(task.id); });
  el.querySelector('.task-claude-btn').addEventListener('click', e => { e.stopPropagation(); toggleClaudeMark(task, el); });
  el.addEventListener('click', e => {
    if (e.target.closest('.task-select-cb') || e.target.closest('.task-done-btn') || e.target.closest('.task-claude-btn')) return;
    openTaskModal(task);
  });

  // Drag to reorder / move
  el.addEventListener('dragstart', e => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.style.opacity = '0.15', 0);
  });
  el.addEventListener('dragend', () => { el.style.opacity = ''; el.classList.remove('drop-above','drop-below'); });

  // Accept drops from other task cards for reordering
  el.addEventListener('dragover', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation();
    const mid = el.getBoundingClientRect().top + el.offsetHeight / 2;
    el.classList.toggle('drop-above', e.clientY < mid);
    el.classList.toggle('drop-below', e.clientY >= mid);
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-above','drop-below'); });
  el.addEventListener('drop', e => {
    if (Array.from(e.dataTransfer.types).includes('col-drag')) return;
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-above','drop-below');
    const fromId = e.dataTransfer.getData('text/plain');
    if (!fromId || fromId === task.id) return;
    const mid = el.getBoundingClientRect().top + el.offsetHeight / 2;
    reorderTask(fromId, col.id, task.id, e.clientY < mid);
  });

  return el;
}

async function toggleClaudeMark(task, cardEl) {
  const marked = task.claude_marked ? 0 : 1;
  task.claude_marked = marked;
  cardEl.querySelector('.task-claude-btn').classList.toggle('active', !!marked);
  await idbPut('tasks', task);
  try { await apiCall('PUT', '/tasks/'+task.id, { claude_marked: marked }); } catch(e) {}
}

async function markTaskDone(taskId) {
  const doneCol = currentBoardData.find(c => isDoneCol(c));
  if (!doneCol) { toast('No "Done" column on this board'); return; }
  await reorderTask(taskId, doneCol.id, null, false);
}

function updateBulkActions() {
  const bar = document.getElementById('bulk-actions');
  if (selectedTasks.size > 0) { bar.classList.remove('hidden'); document.getElementById('sel-count').textContent = selectedTasks.size+' selected'; }
  else bar.classList.add('hidden');
}

async function promptNewBoard() {
  const name = prompt('Board name:'); if(!name?.trim()) return;
  try {
    const board = await apiCall('POST','/boards',{name:name.trim(),columns:['A','B','C','D/W','DONE']});
    boards.push(board); await idbPut('boards',board); renderBoardsBar();
    await selectBoard(board.id);
    currentBoardData.forEach(c => { if (!allColumns.find(a => a.id === c.id)) allColumns.push(c); });
  } catch(e) { toast('Could not create board — try again when online'); }
}
async function promptNewColumn() {
  const name = prompt('Column name:'); if(!name?.trim()) return;
  try {
    const col = await apiCall('POST','/columns',{board_id:currentBoardId,name:name.trim()});
    col.tasks=[]; currentBoardData.push(col); allColumns.push(col); await idbPut('columns',col); renderKanban();
  } catch(e) { toast('Could not add column — try again when online'); }
}
async function promptRenameCol(col) {
  const name = prompt('Rename column:',col.name); if(!name?.trim()||name.trim()===col.name) return;
  col.name=name.trim(); renderKanban();
  const ac = allColumns.find(c => c.id === col.id); if (ac) ac.name = col.name;
  try { await apiCall('PUT','/columns/'+col.id,{name:name.trim()}); } catch(e) {}
}
async function bulkDeleteTasks() {
  if(!selectedTasks.size||!confirm(`Archive ${selectedTasks.size} task(s)?`)) return;
  const ids=[...selectedTasks];
  for(const col of currentBoardData) col.tasks=col.tasks.filter(t=>!selectedTasks.has(t.id));
  for(const id of ids) await idbDelete('tasks',id);
  selectedTasks.clear(); updateBulkActions(); renderKanban();
  try { await apiCall('POST','/tasks/archive',{ids}); } catch(e) {}
}

// ── Task Modal ─────────────────────────────────────────────────
function populateColSelectForBoard(boardId, colId) {
  const sel = document.getElementById('modal-col-select');
  if (!sel) return;
  // Top 3 is drag-only for getting IN — but if the task is already parked there,
  // keep it as the shown option so a plain title edit + Save doesn't bump it out.
  const cols = (boardId === currentBoardId
    ? currentBoardData.slice()
    : allColumns.filter(c => c.board_id === boardId).sort((a, b) => a.position - b.position)
  ).filter(c => c.kind !== 'top3' || c.id === colId);
  sel.innerHTML = cols.map(c =>
    `<option value="${c.id}"${c.id === colId ? ' selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');
}

function populateModalSelects(boardId, colId) {
  const boardSel = document.getElementById('modal-board-select');
  if (boardSel) {
    boardSel.innerHTML = boards.map(b =>
      `<option value="${b.id}"${b.id === boardId ? ' selected' : ''}>${escHtml(b.name)}</option>`
    ).join('');
  }
  populateColSelectForBoard(boardId, colId);
}

function setClaudeMarkBtn(on) {
  modalClaudeMarked = !!on;
  document.getElementById('modal-claude-mark')?.classList.toggle('active', modalClaudeMarked);
}

function openTaskModal(task) {
  modalTaskId = task.id;
  newTaskColId = null;
  setClaudeMarkBtn(task.claude_marked);
  modalTaskTags = taskTags(task);
  renderTaskTagEditor();
  document.getElementById('modal-title').value = task.title;
  document.getElementById('task-modal').classList.remove('hidden');
  const mount = document.getElementById('modal-editor-mount');
  WEditor.destroy(taskEditor);
  taskEditor = WEditor.create(mount, { doc: task.description || '', tabIndent: true, uploadImage });
  populateModalSelects(currentBoardId, task.column_id);
  setTimeout(() => document.getElementById('modal-title').focus(), 30);
}

function openNewTaskModal(colId) {
  newTaskColId = colId;
  modalTaskId = 'new';
  setClaudeMarkBtn(false);
  modalTaskTags = [];
  renderTaskTagEditor();
  document.getElementById('modal-title').value = '';
  document.getElementById('task-modal').classList.remove('hidden');
  const mount = document.getElementById('modal-editor-mount');
  WEditor.destroy(taskEditor);
  taskEditor = WEditor.create(mount, { doc: '', tabIndent: true, uploadImage });
  populateModalSelects(currentBoardId, colId);
  setTimeout(() => document.getElementById('modal-title').focus(), 30);
}

async function persistTaskModal() {
  if (!modalTaskId) return;
  const title = (document.getElementById('modal-title')?.value || '').trim();
  if (!title) return;
  const description = WEditor.getText(taskEditor);
  const claude_marked = modalClaudeMarked ? 1 : 0;
  const tags = modalTaskTags.join(',');

  if (modalTaskId === 'new') {
    const col = currentBoardData.find(c => c.id === newTaskColId);
    if (!col) return;
    try {
      const task = await apiCall('POST', '/tasks', { column_id: newTaskColId, title, description, claude_marked, tags });
      col.tasks.push(task); await idbPut('tasks', task);
    } catch(e) {
      const id = 'local_'+Date.now(), t = Date.now();
      const task = { id, column_id: newTaskColId, title, description, claude_marked, tags, position: col.tasks.length, created_at: t, updated_at: t };
      col.tasks.push(task); await idbPut('tasks', task);
      await queueForSync({ method:'POST', path:'/tasks', body:{ column_id: newTaskColId, title, description, claude_marked, tags } });
    }
    renderKanban();
  } else {
    const id = modalTaskId;
    const newColId = document.getElementById('modal-col-select')?.value;
    const newBoardId = document.getElementById('modal-board-select')?.value;
    const crossBoard = newBoardId && newBoardId !== currentBoardId;
    let oldColId = null;
    for (const col of currentBoardData) {
      const tidx = col.tasks.findIndex(t => t.id === id);
      if (tidx < 0) continue;
      oldColId = col.id;
      if (crossBoard) {
        col.tasks.splice(tidx, 1);
      } else {
        const t = col.tasks[tidx];
        t.title = title; t.description = description; t.claude_marked = claude_marked; t.tags = tags;
        if (newColId && newColId !== col.id) {
          const moved = { ...t, column_id: newColId };
          col.tasks.splice(tidx, 1);
          const destCol = currentBoardData.find(c => c.id === newColId);
          if (destCol) destCol.tasks.push(moved);
        }
      }
      break;
    }
    renderKanban();
    if (crossBoard) {
      await idbDelete('tasks', id);
      try { await apiCall('PUT', '/tasks/'+id, { title, description, claude_marked, tags, column_id: newColId }); } catch(e) {}
    } else {
      const colChanged = newColId && newColId !== oldColId;
      const updated = await idbGet('tasks', id);
      const merged = { ...updated, title, description, claude_marked, tags, ...(colChanged ? { column_id: newColId } : {}) };
      if (updated) await idbPut('tasks', merged);
      try { await apiCall('PUT', '/tasks/'+id, { title, description, claude_marked, tags, ...(colChanged ? { column_id: newColId } : {}) }); } catch(e) {}
    }
  }
}

function destroyTaskModal() {
  WEditor.destroy(taskEditor); taskEditor = null;
  document.getElementById('task-modal').classList.add('hidden');
  modalTaskId = null; newTaskColId = null; modalClaudeMarked = false; modalTaskTags = [];
}

async function saveTaskModal() {
  const title = document.getElementById('modal-title').value.trim();
  if (!title) { toast('Task needs a title'); return; }
  await persistTaskModal();
  destroyTaskModal();
}

async function archiveTaskFromModal() {
  if (modalTaskId === 'new') { destroyTaskModal(); return; }
  if (!confirm('Archive this task?')) return;
  const id = modalTaskId;
  for (const col of currentBoardData) col.tasks = col.tasks.filter(t => t.id !== id);
  selectedTasks.delete(id); updateBulkActions(); destroyTaskModal();
  await idbDelete('tasks', id); renderKanban();
  try { await apiCall('POST', '/tasks/'+id+'/archive'); } catch(e) {}
}

async function closeTaskModal() {
  await persistTaskModal();
  destroyTaskModal();
}

// ── Online/offline ─────────────────────────────────────────────
function updateOnlineDot() {
  const dot=document.getElementById('online-dot');
  if(dot){dot.classList.toggle('offline',!navigator.onLine);dot.title=navigator.onLine?'Online':'Offline';}
}
window.addEventListener('online',()=>{updateOnlineDot();flushOutbox();});
window.addEventListener('offline',updateOnlineDot);

// ── Keyboard shortcuts ─────────────────────────────────────────
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const dropdownOpen = !document.getElementById('search-dropdown').classList.contains('hidden');

  // Cmd/Ctrl+S: everything autosaves already — just flush any pending note save
  // and confirm, instead of popping the browser's "Save page" dialog.
  if (mod && e.key === 's') {
    e.preventDefault();
    if (currentNoteId && noteEditor) { clearTimeout(saveNoteTimer); saveCurrentNote(); toast('Saved'); }
    return;
  }
  if (e.key === 'Escape') {
    if (dropdownOpen) { closeSearch(); return; }
    if (!document.getElementById('reminder-modal').classList.contains('hidden')) { closeReminderModal(); return; }
    if (!document.getElementById('expense-modal').classList.contains('hidden')) { closeExpenseModal(); return; }
    if (!document.getElementById('task-modal').classList.contains('hidden')) { closeTaskModal(); return; }
  }
  if (dropdownOpen) {
    const items = document.querySelectorAll('#search-dropdown .search-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchIdx = Math.min(searchIdx + 1, items.length - 1);
      if (searchIdx < 0) searchIdx = 0;
      updateSearchSel();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchIdx = Math.max(searchIdx - 1, 0);
      updateSearchSel();
    } else if (e.key === 'Enter' && searchFlat.length) {
      activateSearch(searchIdx >= 0 ? searchIdx : 0); // Enter with nothing highlighted opens the top hit
    }
  }
});

// ── Event wiring ───────────────────────────────────────────────
// Search bar
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderSearch(searchInput.value), 150);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('#search-bar-wrap')) closeSearch();
});

// PIN pad
document.querySelectorAll('.pin-key[data-d]').forEach(btn => btn.addEventListener('click', () => pinDigit(btn.dataset.d)));
document.getElementById('pin-back').addEventListener('click', pinBack);
document.getElementById('pin-ok').addEventListener('click', pinSubmit);
document.getElementById('add-board-btn').addEventListener('click', promptNewBoard);
document.getElementById('trash-btn').addEventListener('click', () => switchTab('trash'));
document.getElementById('archive-btn').addEventListener('click', () => switchTab('archive'));
document.getElementById('lock-btn').addEventListener('click', logout);
document.addEventListener('keydown', e => {
  if (!document.getElementById('login-overlay').classList.contains('hidden')) {
    if (e.key >= '0' && e.key <= '9') pinDigit(e.key);
    else if (e.key === 'Backspace') pinBack();
    else if (e.key === 'Enter') pinSubmit();
  }
});
// Mobile search toggle
document.getElementById('search-toggle-btn').addEventListener('click', e => {
  e.stopPropagation();
  const inp = document.getElementById('search-input');
  document.getElementById('search-bar-wrap').classList.add('mobile-open');
  inp.value = '';
  inp.focus();
});
document.getElementById('search-close-btn').addEventListener('click', e => {
  e.stopPropagation();
  closeSearch();
});
// Sidebar toggle
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('left-panel').classList.contains('collapsed') ? openSidebar() : closeSidebar();
});
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
// Nav items inside left panel
document.querySelectorAll('.nav-menu-item').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// Nav dropdown: #left-panel-nav always shows just the active section's row
// (app.css hides the rest there) — its own ▾ moves the other 8 rows into
// #nav-popup, a small floating window over the app, instead of growing the
// sidebar's own layout open. #left-panel-nav's footprint never changes, so
// nothing below it in the panel shifts when the popup opens/closes.
function isNavPopupOpen() { return !document.getElementById('nav-popup').classList.contains('hidden'); }
function openNavDropdown() {
  const nav = document.getElementById('left-panel-nav');
  const popup = document.getElementById('nav-popup');
  const activeRow = nav.querySelector('.nav-row:has(.nav-menu-item.active)');
  if (!activeRow) return;
  const r = activeRow.getBoundingClientRect(); // measured BEFORE the popup opens
  nav.querySelectorAll('.nav-row').forEach(row => { if (row !== activeRow) popup.appendChild(row); });
  const margin = 8;
  const maxH = Math.min(window.innerHeight * 0.6, 420);
  let top = r.bottom + 2;
  if (top + maxH > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - maxH - margin);
  popup.style.top = top + 'px';
  popup.style.left = r.left + 'px';
  popup.style.width = r.width + 'px';
  popup.classList.remove('hidden');
  document.querySelector('.nav-row:has(.nav-menu-item.active) .nav-expand-btn')?.classList.add('nav-expand-open');
  updateReorderBtnStates();
}
function closeNavDropdown() {
  const nav = document.getElementById('left-panel-nav');
  const popup = document.getElementById('nav-popup');
  if (!nav || !popup) return;
  popup.querySelectorAll('.nav-row').forEach(row => nav.appendChild(row));
  popup.classList.add('hidden');
  popup.style.top = popup.style.left = popup.style.width = '';
  document.querySelectorAll('.nav-expand-open').forEach(b => b.classList.remove('nav-expand-open'));
}
document.getElementById('left-panel').addEventListener('click', e => {
  const btn = e.target.closest('.nav-expand-btn');
  if (!btn) return;
  e.stopPropagation();
  isNavPopupOpen() ? closeNavDropdown() : openNavDropdown();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#left-panel-nav') && !e.target.closest('#nav-popup')) closeNavDropdown();
});
window.addEventListener('resize', closeNavDropdown);
// Drag-to-reorder the nav tabs themselves (Notes/Projects/Expenses/Calendar).
// Rows are static markup (not re-rendered from an array), so reordering just
// moves the existing DOM nodes — listeners already attached to them travel
// along for free. Order persists the same way as expense-col-order.
// Reordering only ever happens among rows sitting in #nav-popup (the active
// row, alone in #left-panel-nav, has nothing to reorder against) — moveRow
// and the drag handlers work off row.parentElement so they're correct
// whichever container currently holds the row.
let navDragEl = null;
function applyNavOrder() {
  const nav = document.getElementById('left-panel-nav');
  let order;
  try { order = JSON.parse(localStorage.getItem('nav-tab-order') || 'null'); } catch(e) { order = null; }
  if (!Array.isArray(order)) return;
  const rows = new Map([...nav.querySelectorAll('.nav-row')].map(r => [r.dataset.tab, r]));
  order.forEach(tab => { const r = rows.get(tab); if (r) nav.appendChild(r); });
  // A tab added after the order was saved (e.g. Calls landing on a 4-tab
  // list) would otherwise be left stranded ABOVE the reordered rows —
  // new tabs belong at the bottom until the user places them.
  rows.forEach((r, tab) => { if (!order.includes(tab)) nav.appendChild(r); });
}
// The active tab is excluded from #nav-popup, so it isn't part of what gets
// reordered there — pin it to the front of the saved order and leave it be;
// since only rank-by-.active (not array position) decides what's collapsed,
// this has no visible effect beyond the popup's own row sequence.
function saveNavOrder() {
  const activeTab = document.querySelector('.nav-menu-item.active')?.dataset.tab;
  const popupOrder = [...document.getElementById('nav-popup').querySelectorAll('.nav-row')].map(r => r.dataset.tab);
  localStorage.setItem('nav-tab-order', JSON.stringify([activeTab, ...popupOrder].filter(Boolean)));
}
// Touch devices never fire HTML5 drag events at all — the ▲/▼ buttons
// (shown only on coarse pointers, see app.css) are the touch equivalent.
function updateReorderBtnStates() {
  const rows = [...document.getElementById('nav-popup').querySelectorAll('.nav-row')];
  rows.forEach((row, i) => {
    row.querySelector('.nav-up-btn').disabled = i === 0;
    row.querySelector('.nav-down-btn').disabled = i === rows.length - 1;
  });
}
function moveNavRow(row, dir) {
  const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sib) return;
  const parent = row.parentElement;
  dir < 0 ? parent.insertBefore(row, sib) : parent.insertBefore(sib, row);
  saveNavOrder(); updateReorderBtnStates();
}
applyNavOrder();
document.getElementById('left-panel').addEventListener('click', e => {
  const btn = e.target.closest('.nav-up-btn, .nav-down-btn');
  if (!btn || btn.disabled) return;
  e.stopPropagation();
  moveNavRow(btn.closest('.nav-row'), btn.classList.contains('nav-up-btn') ? -1 : 1);
});
document.querySelectorAll('.nav-row').forEach(row => {
  row.addEventListener('dragstart', e => {
    navDragEl = row;
    e.dataTransfer.setData('nav-row-drag', row.dataset.tab);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => row.classList.add('dragging'), 0);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    row.parentElement?.querySelectorAll('.nav-row').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    navDragEl = null;
  });
  row.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer.types).includes('nav-row-drag') || row === navDragEl) return;
    e.preventDefault();
    const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.classList.toggle('drop-above', e.clientY < mid);
    row.classList.toggle('drop-below', e.clientY >= mid);
  });
  row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-above', 'drop-below'); });
  row.addEventListener('drop', e => {
    if (!navDragEl || navDragEl === row) return;
    e.preventDefault();
    const insertBefore = row.classList.contains('drop-above');
    row.classList.remove('drop-above', 'drop-below');
    row.parentElement.insertBefore(navDragEl, insertBefore ? row : row.nextSibling);
    saveNavOrder(); updateReorderBtnStates();
  });
});
// Mobile col nav
document.getElementById('prev-col-btn').addEventListener('click', () => goToMobileCol(mobileColIdx - 1));
document.getElementById('next-col-btn').addEventListener('click', () => goToMobileCol(mobileColIdx + 1));
document.getElementById('empty-trash-btn')?.addEventListener('click', async () => {
  if (!confirm('Permanently delete all items in trash?')) return;
  try { await apiCall('DELETE', '/trash/empty'); loadTrash(); toast('Trash emptied'); } catch(e) { toast('Could not empty trash'); }
});
document.getElementById('new-note-btn').addEventListener('click',newNote);
document.getElementById('import-btn').addEventListener('click',()=>document.getElementById('import-input').click());
document.getElementById('import-input').addEventListener('change',e=>{if(e.target.files.length){importMdFiles(Array.from(e.target.files));e.target.value='';}});
document.getElementById('add-expense-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('expenses'); openExpenseModal(); });
document.getElementById('expense-modal-close').addEventListener('click', closeExpenseModal);
document.getElementById('expense-modal-cancel').addEventListener('click', closeExpenseModal);
document.getElementById('expense-modal-save').addEventListener('click', saveExpense);
// Enter in a plain field saves the expense (datalist fields excluded — there Enter picks a suggestion)
document.getElementById('expense-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input:not([list])')) { e.preventDefault(); saveExpense(); }
});
document.getElementById('expense-modal-delete').addEventListener('click', deleteExpense);
document.getElementById('expense-modal').addEventListener('click', e => { if (e.target === document.getElementById('expense-modal')) closeExpenseModal(); });
document.getElementById('export-csv-btn').addEventListener('click', exportExpensesCsv);
document.getElementById('import-csv-input').addEventListener('change', e => { if (e.target.files.length) { handleExpenseImport(e.target.files[0]); e.target.value = ''; } });
document.getElementById('chase-import-close')?.addEventListener('click', () => { document.getElementById('chase-import-modal').classList.add('hidden'); chaseImportPending = null; });
document.getElementById('chase-import-cancel')?.addEventListener('click', () => { document.getElementById('chase-import-modal').classList.add('hidden'); chaseImportPending = null; });
document.getElementById('chase-import-confirm')?.addEventListener('click', confirmChaseImport);
document.getElementById('chase-import-modal')?.addEventListener('click', e => { if (e.target === document.getElementById('chase-import-modal')) { chaseImportPending = null; e.target.classList.add('hidden'); } });
// To Do (Eisenhower matrix)
document.getElementById('todo-date').addEventListener('change', e => loadEisenhowerDay(e.target.value));
document.getElementById('todo-today-btn').addEventListener('click', () => loadEisenhowerDay(eisenhowerTodayISO()));
document.getElementById('todo-clear-btn').addEventListener('click', async () => {
  if (!confirm('Clear all four boxes for this day?')) return;
  EISENHOWER_QUADS.forEach(q => { document.getElementById('todo-input-' + q).value = ''; });
  try { await apiCall('PUT', '/eisenhower/' + eisenhowerLoadedDate, { do: '', schedule: '', delegate: '', delete: '' }); } catch (e) {}
});
EISENHOWER_QUADS.forEach(q => {
  document.getElementById('todo-input-' + q).addEventListener('input', () => eisenhowerScheduleSave(q));
});
// Calendar / reminders
document.getElementById('add-reminder-btn').addEventListener('click', () => { switchTab('calendar'); openReminderModal(); });
const calToggleBtn = document.getElementById('calendar-view-toggle-btn');
updateCalToggleBtn();
calToggleBtn.addEventListener('click', () => {
  if (CAL_SPLIT_MQ.matches) {
    calendarMonthVisible = !calendarMonthVisible;
    localStorage.setItem('calendar-month-visible', calendarMonthVisible ? '1' : '0');
  } else {
    calendarViewMode = calendarViewMode === 'agenda' ? 'month' : 'agenda';
    localStorage.setItem('calendar-view-mode', calendarViewMode);
  }
  renderCalendarActive();
});
CAL_SPLIT_MQ.addEventListener('change', () => { if (currentTab === 'calendar') renderCalendarActive(); });
document.getElementById('reminder-modal-close').addEventListener('click', closeReminderModal);
document.getElementById('reminder-modal-cancel').addEventListener('click', closeReminderModal);
document.getElementById('reminder-modal-save').addEventListener('click', saveReminder);
document.getElementById('reminder-modal-delete').addEventListener('click', archiveReminder);
document.getElementById('reminder-modal').addEventListener('click', e => { if (e.target === document.getElementById('reminder-modal')) closeReminderModal(); });
document.getElementById('reminder-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input:not([type="time"])')) { e.preventDefault(); saveReminder(); }
});
document.getElementById('rem-recur').addEventListener('change', updateRecurRows);
document.getElementById('rem-lead').addEventListener('input', e => {
  document.getElementById('rem-lead-unit').disabled = !e.target.value.trim();
});
// ── Cold Email (Instantly daily reporting) ─────────────────────
const CE_METRICS = [
  { key: 'sent', label: 'Sent', color: '#4a90e0' },
  { key: 'opens', label: 'Opens', color: '#4caf32' },
  { key: 'replies', label: 'Replies', color: '#e0a94a' },
  { key: 'bounces', label: 'Bounces', color: '#e05a4a' },
];

async function loadColdEmail() {
  try {
    [coldEmailDaily, coldEmailAccounts, coldEmailReplies, coldEmailStatus] = await Promise.all([
      apiCall('GET', '/cold-email/daily?days=' + coldEmailDays),
      apiCall('GET', '/cold-email/accounts'),
      apiCall('GET', '/cold-email/replies'),
      apiCall('GET', '/cold-email/status'),
    ]);
  } catch (e) { toast('Could not load cold email data'); return; }
  renderColdEmail();
}

function ceLastRefreshedHtml() {
  const s = coldEmailStatus;
  if (!s) return '';
  if (!s.configured) return '<span style="color:#e0a94a;">Instantly key not configured on the server</span>';
  if (!s.last_success_at) return '<span style="color:#999;">Never refreshed yet</span>';
  const errBit = s.last_error ? ` <span style="color:#e05a4a;" title="${escHtml(s.last_error)}">(last attempt failed)</span>` : '';
  return `<span style="color:#999;">Last refreshed: ${escHtml(fmtDate(s.last_success_at))}</span>${errBit}`;
}

async function refreshColdEmail() {
  toast('Refreshing…');
  try {
    await apiCall('POST', '/cold-email/pull');
    toast('Refreshed');
  } catch (e) { toast('Refresh failed — check INSTANTLY_API_KEY is configured'); }
  await loadColdEmail();
}

function ceFmtCompact(v) {
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

function ceFmtDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

function ceByDate(rows) {
  const byDate = {};
  for (const r of rows) {
    const b = (byDate[r.date] ??= { sent: 0, opens: 0, replies: 0, bounces: 0, unread_replies: 0 });
    b.sent += r.sent; b.opens += r.opens; b.replies += r.replies; b.bounces += r.bounces;
    b.unread_replies += r.unread_replies;
  }
  return byDate;
}

function ceStatTilesHtml(rows) {
  const totals = rows.reduce((a, r) => ({
    sent: a.sent + r.sent, opens: a.opens + r.opens, replies: a.replies + r.replies, bounces: a.bounces + r.bounces,
  }), { sent: 0, opens: 0, replies: 0, bounces: 0 });
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';
  const tiles = [
    ['Sent', totals.sent],
    ['Open rate', pct(totals.opens, totals.sent)],
    ['Reply rate', pct(totals.replies, totals.sent)],
    ['Bounce rate', pct(totals.bounces, totals.sent)],
  ];
  return `<div class="exp-chart-stats" style="padding:0 0 24px;">${tiles.map(([label, val]) => `
    <div class="exp-chart-stat">
      <span class="exp-chart-stat-val">${escHtml(String(val))}</span>
      <span class="exp-chart-stat-label">${escHtml(label)}</span>
    </div>`).join('')}</div>`;
}

function ceChartHtml(rows) {
  const byDate = ceByDate(rows);
  const dates = Object.keys(byDate).sort();
  const legend = CE_METRICS.map(m => {
    const hidden = ceChartHiddenSeries.has(m.key);
    return `<span class="exp-chart-legend-item${hidden ? ' hidden-series' : ''}" data-metric="${m.key}" title="Click to ${hidden ? 'show' : 'isolate/hide'}"><span class="exp-chart-legend-swatch" style="background:${m.color}"></span>${m.label}</span>`;
  }).join('');
  if (dates.length < 2) {
    return `<div class="expense-chart-wrap"><div class="exp-chart-legend">${legend}</div><div class="expense-chart-empty">Not enough days of data yet — check back after the pull has run a few times.</div></div>`;
  }
  const visible = CE_METRICS.filter(m => !ceChartHiddenSeries.has(m.key));
  let maxVal = 0;
  for (const m of visible) for (const dt of dates) maxVal = Math.max(maxVal, byDate[dt][m.key] || 0);
  const niceMax = niceCeil(maxVal || 1);
  const W = 900, H = 260, padL = 44, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xFor = i => padL + (dates.length > 1 ? (i / (dates.length - 1)) * plotW : plotW / 2);
  const yFor = v => padT + plotH - (v / niceMax) * plotH;

  let gridLines = '', yLabels = '';
  for (let i = 0; i <= 4; i++) {
    const val = niceMax * i / 4, y = yFor(val);
    gridLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="exp-chart-grid"/>`;
    yLabels += `<text x="${padL - 8}" y="${y + 4}" class="exp-chart-axis-label" text-anchor="end">${ceFmtCompact(val)}</text>`;
  }
  let xLabels = '';
  const labelStep = dates.length > 10 ? Math.ceil(dates.length / 10) : 1;
  dates.forEach((dt, i) => {
    if (i % labelStep !== 0 && i !== dates.length - 1) return;
    xLabels += `<text x="${xFor(i)}" y="${H - 8}" class="exp-chart-axis-label" text-anchor="middle">${ceFmtDateLabel(dt)}</text>`;
  });
  let paths = '';
  visible.forEach(m => {
    const pts = dates.map((dt, i) => `${xFor(i)},${yFor(byDate[dt][m.key] || 0)}`).join(' ');
    paths += `<polyline points="${pts}" fill="none" stroke="${m.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    dates.forEach((dt, i) => {
      paths += `<circle cx="${xFor(i)}" cy="${yFor(byDate[dt][m.key] || 0)}" r="3" fill="${m.color}"><title>${ceFmtDateLabel(dt)}: ${byDate[dt][m.key] || 0} ${m.label.toLowerCase()}</title></circle>`;
    });
  });
  return `
    <div class="expense-chart-wrap">
      <div class="exp-chart-legend">${legend}</div>
      <svg class="exp-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${gridLines}${yLabels}${xLabels}${paths}
      </svg>
    </div>`;
}

function ceCampaignTableHtml(rows) {
  const byCampaign = {};
  for (const r of rows) {
    const c = (byCampaign[r.campaign_id] ??= { name: r.campaign_name || r.campaign_id, sent: 0, replies: 0, unread: 0, lastDate: '' });
    c.sent += r.sent; c.replies += r.replies;
    if (r.date > c.lastDate) { c.lastDate = r.date; c.unread = r.unread_replies; }
  }
  const campaigns = Object.values(byCampaign).sort((a, b) => b.sent - a.sent);
  if (!campaigns.length) return '<div class="expense-chart-empty">No campaign data yet.</div>';
  return `<table class="ce-table"><thead><tr><th>Campaign</th><th>Sent</th><th>Replies</th><th>Unread</th></tr></thead><tbody>
    ${campaigns.map(c => `<tr><td>${escHtml(c.name)}</td><td>${c.sent}</td><td>${c.replies}</td><td>${c.unread ? `<span class="ce-unread-badge">${c.unread}</span>` : '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

function ceInterestBadge(v) {
  if (v == null) return '';
  if (v > 0) return '<span class="ce-interest-badge ce-interest-pos">Interested</span>';
  if (v < 0) return '<span class="ce-interest-badge ce-interest-neg">Not interested</span>';
  return '<span class="ce-interest-badge ce-interest-neu">Neutral</span>';
}

function ceRepliesHtml(replies) {
  if (!replies.length) return '<div class="expense-chart-empty">No replies yet.</div>';
  return replies.map(r => `
    <div class="ce-reply-card${r.is_unread ? ' ce-reply-unread' : ''}">
      <div class="ce-reply-head">
        <span class="ce-reply-from">${escHtml(r.from_name || r.from_email)}</span>
        <span class="ce-reply-date">${escHtml(fmtDate(r.timestamp_email))}</span>
      </div>
      <div class="ce-reply-subject">${escHtml(r.subject)} ${ceInterestBadge(r.ai_interest)}${r.is_unread ? '<span class="ce-unread-badge" style="margin-left:6px;">unread</span>' : ''}</div>
      <div class="ce-reply-preview">${escHtml(r.preview)}</div>
      <div class="ce-reply-meta">${escHtml(r.campaign_name || r.campaign_id)} · ${escHtml(r.from_email)}</div>
    </div>`).join('');
}

function ceAccountTableHtml(accounts) {
  if (!accounts.length) return '<div class="expense-chart-empty">No account health data yet.</div>';
  return `<table class="ce-table"><thead><tr><th>Inbox</th><th>Warmup score</th><th>Daily limit</th></tr></thead><tbody>
    ${accounts.map(a => `<tr><td>${escHtml(a.account_email)}</td><td>${a.warmup_score ?? '—'}</td><td>${a.daily_limit ?? '—'}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderColdEmail() {
  const area = document.getElementById('cold-email-area');
  if (!area) return;
  area.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <h2 style="margin:0;font-size:16px;color:#e0e0e0;">Cold Email</h2>
      <div>
        <select id="ce-days-select" style="margin-right:8px;">
          <option value="7"${coldEmailDays === 7 ? ' selected' : ''}>Last 7 days</option>
          <option value="30"${coldEmailDays === 30 ? ' selected' : ''}>Last 30 days</option>
          <option value="90"${coldEmailDays === 90 ? ' selected' : ''}>Last 90 days</option>
        </select>
        <button id="ce-refresh-inline-btn">↻ Refresh now</button>
      </div>
    </div>
    <div style="font-size:12px;margin-bottom:16px;">${ceLastRefreshedHtml()}</div>
    ${ceStatTilesHtml(coldEmailDaily)}
    ${ceChartHtml(coldEmailDaily)}
    <h3 style="font-size:13px;color:#999;margin:24px 0 8px;">Recent replies</h3>
    <div class="ce-replies-list">${ceRepliesHtml(coldEmailReplies)}</div>
    <h3 style="font-size:13px;color:#999;margin:24px 0 8px;">Campaigns</h3>
    ${ceCampaignTableHtml(coldEmailDaily)}
    <h3 style="font-size:13px;color:#999;margin:24px 0 8px;">Inbox health</h3>
    ${ceAccountTableHtml(coldEmailAccounts)}
  `;
  area.querySelectorAll('.exp-chart-legend-item').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.metric;
      ceChartHiddenSeries.has(key) ? ceChartHiddenSeries.delete(key) : ceChartHiddenSeries.add(key);
      renderColdEmail();
    });
  });
  document.getElementById('ce-days-select')?.addEventListener('change', e => {
    coldEmailDays = parseInt(e.target.value, 10);
    loadColdEmail();
  });
  document.getElementById('ce-refresh-inline-btn')?.addEventListener('click', refreshColdEmail);
}

document.getElementById('rem-weekdays').addEventListener('click', e => {
  const btn = e.target.closest('.rem-wd');
  if (!btn) return;
  const d = +btn.dataset.d;
  remWeekdaySel.has(d) ? remWeekdaySel.delete(d) : remWeekdaySel.add(d);
  renderWeekdayPills();
});
document.getElementById('enable-notifs-btn').addEventListener('click', enableNotifications);
// CRM: dialer (inside the Calls sub-tab)
document.getElementById('dial-pad').addEventListener('click', e => {
  const k = e.target.closest('.dial-key');
  if (k) dialKeyPress(k.dataset.k);
});
document.getElementById('dial-back').addEventListener('click', () => {
  const i = document.getElementById('dial-number');
  i.value = i.value.slice(0, -1); i.focus();
});
document.getElementById('dial-call-btn').addEventListener('click', startCall);
document.getElementById('dial-hangup-btn').addEventListener('click', hangUp);
document.getElementById('dial-number').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); startCall(); }
});
document.getElementById('dial-number').addEventListener('change', e => savePhoneBackToLead(e.target.value));
// Standalone Dialer tab (v162)
document.getElementById('new-call-btn').addEventListener('click', () => {
  switchTab('dialer');
  if (isMobile()) closeSidebar();
  setTimeout(() => document.getElementById('dial-number')?.focus(), 50);
});
document.getElementById('prospect-new-list-btn').addEventListener('click', newProspectList);
document.getElementById('prospect-scrape-btn').addEventListener('click', scrapeNewProspects);
document.getElementById('prospect-import-btn').addEventListener('click', openProspectImportModal);
document.getElementById('prospect-import-close').addEventListener('click', closeProspectImportModal);
document.getElementById('prospect-import-cancel').addEventListener('click', closeProspectImportModal);
document.getElementById('prospect-import-confirm').addEventListener('click', submitProspectImport);
document.getElementById('prospect-import-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('prospect-import-modal')) closeProspectImportModal();
});
// CRM: nav +, inner tab strip, floating call bar, disposition modal
document.getElementById('new-lead-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('crm'); newLeadForm(); });
document.querySelectorAll('.crm-subtab').forEach(b => b.addEventListener('click', () => switchCrmSub(b.dataset.sub)));
document.getElementById('call-float-hangup').addEventListener('click', hangUp);
document.getElementById('disposition-close').addEventListener('click', closeDispositionModal);
document.getElementById('disposition-skip').addEventListener('click', () => {
  const leadId = dispositionLeadId;
  const advance = dispositionAdvance;
  closeDispositionModal();
  if (advance) advanceToNextLead(leadId);
});
document.getElementById('incoming-accept').addEventListener('click', acceptIncoming);
document.getElementById('incoming-decline').addEventListener('click', declineIncoming);
document.getElementById('disposition-custom').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const name = e.target.value.trim().toLowerCase();
  if (!name) return;
  addDispositionOption(name);
  pickDisposition(name);
});
document.getElementById('new-daily-task-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('daily-tasks'); newDailyTaskPaste(); });
document.getElementById('cold-email-refresh-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('cold-email'); refreshColdEmail(); });
document.getElementById('bulk-delete-btn').addEventListener('click',bulkDeleteTasks);
document.getElementById('cancel-sel-btn').addEventListener('click',()=>{selectedTasks.clear();updateBulkActions();renderKanban();});
document.getElementById('modal-close').addEventListener('click',closeTaskModal);
document.getElementById('modal-delete').addEventListener('click',archiveTaskFromModal);
document.getElementById('modal-claude-mark').addEventListener('click',()=>setClaudeMarkBtn(!modalClaudeMarked));
document.getElementById('modal-board-select')?.addEventListener('change', e => {
  const colSel = document.getElementById('modal-col-select');
  const currentCol = colSel?.value;
  populateColSelectForBoard(e.target.value, currentCol);
});
document.getElementById('task-modal').addEventListener('click',e=>{if(e.target===document.getElementById('task-modal'))closeTaskModal();});

// ── Leads (CRM hub tying audits/followups/cold-email replies together) ──
// See CRM-UNIFICATION-PLAN.md. No relational/blob split here — the list rows
// are server-computed rollups, the detail record carries the full linked
// audits/followups/replies arrays for the merged timeline.
let leads = [];
let currentLeadId = null;
let currentLead = null; // full record from GET /api/leads/:id
let leadsView = 'empty'; // empty | detail | new | unmatched
let leadUnmatched = null;
let crmSubTab = 'overview'; // overview | audit | followup | calls — which sub-view of the open lead is showing

async function loadLeads() {
  try { leads = await apiCall('GET', '/leads'); } catch (e) { toast('Could not load leads'); return; }
  renderLeadsList();
}

function loadCrm() {
  loadLeads();
  loadUsagePanel();
}

// The inner tab strip is pure navigation (rfy-crm §1.4): thin header on top,
// whichever sub-view is active rendered FULL SIZE below it — the audit editor
// and dialer keep the exact layout they had as standalone tabs.
function updateCrmHeader() {
  const head = document.getElementById('crm-detail-header');
  if (!head) return;
  const show = leadsView === 'detail' && currentLead;
  head.classList.toggle('hidden', !show);
  if (show) document.getElementById('crm-lead-name').textContent = currentLead.business_name || 'Untitled lead';
  document.querySelectorAll('.crm-subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === crmSubTab));
}

function showCrmSub(sub) {
  ['overview', 'audit', 'followup', 'calls'].forEach(s =>
    document.getElementById('crm-' + s + '-sub')?.classList.toggle('hidden', s !== sub));
}

function switchCrmSub(sub, preferId) {
  crmSubTab = sub;
  updateCrmHeader();
  showCrmSub(sub);
  if (!currentLead) return;
  if (sub === 'overview') renderLeadEditor(currentLead, false);
  if (sub === 'audit') renderCrmAuditSub(preferId);
  if (sub === 'followup') renderCrmFollowupSub(preferId);
  if (sub === 'calls') renderCrmCallsSub();
}

function leadStatusColor(s) {
  return { active: '#5fc83b', won: '#2e7d32', lost: '#c0392b', dormant: '#666' }[s] || '#666';
}

function renderLeadsList() {
  const area = document.getElementById('leads-list');
  if (!area) return;
  const rows = leads.map(l => {
    const badges = [];
    if (l.disposition) badges.push(`<span class="note-tag" style="--tag-c:${tagColor(l.disposition)}">${escHtml(l.disposition)}</span>`);
    if (l.audit_count) badges.push(`<span class="note-tag">${l.audit_count} audit${l.audit_count > 1 ? 's' : ''}</span>`);
    if (l.unread_replies) badges.push(`<span class="note-tag" style="--tag-c:#c0392b">${l.unread_replies} unread</span>`);
    if (l.next_followup_label) {
      const overdue = l.next_followup_due && l.next_followup_due < Date.now();
      badges.push(`<span class="note-tag"${overdue ? ' style="--tag-c:#c0392b"' : ''}>${overdue ? 'Overdue: ' : 'Next: '}${escHtml(l.next_followup_label)}</span>`);
    }
    return `
    <div class="note-item${leadsView === 'detail' && l.id === currentLeadId ? ' active' : ''}" data-id="${l.id}">
      <div class="note-item-title">${escHtml(l.business_name || 'Untitled lead')}</div>
      <div class="note-item-snippet">${escHtml(l.website || l.city || '')} <span style="color:${leadStatusColor(l.status)}">● ${escHtml(l.status)}</span></div>
      <div class="note-item-tags">${badges.join('')}</div>
    </div>`;
  }).join('') || '<div style="padding:16px 12px;color:#444;font-size:12px;">No leads yet.</div>';
  area.innerHTML = `<div class="note-item${leadsView === 'unmatched' ? ' active' : ''}" data-unmatched="1" style="border-left:2px solid #c9a227;">
      <div class="note-item-title">⚠ Unmatched</div>
      <div class="note-item-snippet">Audits, follow-ups, replies not yet linked to a lead</div>
    </div>` + rows;
  area.querySelectorAll('.note-item[data-id]').forEach(el => el.addEventListener('click', () => openLead(el.dataset.id)));
  area.querySelector('[data-unmatched]')?.addEventListener('click', openUnmatched);
}

function newLeadForm() {
  currentLeadId = null; currentLead = null; leadsView = 'new'; crmSubTab = 'overview';
  renderLeadsList();
  updateCrmHeader(); showCrmSub('overview');
  renderLeadEditor({ business_name: '', website: '', primary_email: '', city: '', niche: '', notes: '', status: 'active',
    contact_name: '', phone_number: '', address: '', source: '', disposition: '' }, true);
}

function jumpToLead(id) {
  switchTab('crm');
  openLead(id);
}

async function openLead(id, sub) {
  let l;
  try { l = await apiCall('GET', '/leads/' + id); } catch (e) { toast('Could not load lead'); return; }
  currentLeadId = id; currentLead = l; leadsView = 'detail';
  renderLeadsList();
  switchCrmSub(sub || 'overview');
  if (isMobile()) closeSidebar();
}

async function openUnmatched() {
  currentLeadId = null; currentLead = null; leadsView = 'unmatched'; crmSubTab = 'overview';
  renderLeadsList();
  updateCrmHeader(); showCrmSub('overview');
  try { leadUnmatched = await apiCall('GET', '/leads/unmatched'); } catch (e) { toast('Could not load unmatched items'); return; }
  renderUnmatchedView();
}

function leadFieldRow(label, id, value, type) {
  return `<div class="expense-field-row">
    <label>${escHtml(label)}</label>
    <input type="${type || 'text'}" id="${id}" value="${escHtml(value || '')}">
  </div>`;
}

// Disposition options (rfy-crm §1.7): positive/warm/cold/no by default,
// customizable — new names typed in the picker persist here. Colors ride the
// EXISTING shared tag/color store (tagColor/setTagColor), not a second system.
function dispositionOptions() {
  try {
    const v = JSON.parse(localStorage.getItem('crm-dispositions') || 'null');
    if (Array.isArray(v) && v.length) return v;
  } catch (e) {}
  return ['positive', 'warm', 'cold', 'no'];
}
function addDispositionOption(name) {
  const opts = dispositionOptions();
  if (!opts.includes(name)) { opts.push(name); localStorage.setItem('crm-dispositions', JSON.stringify(opts)); }
}

// Tag-style pill row with a color dot per pill (same recolor pattern as the
// Daily Tasks category pills — click the dot, native color input, setTagColor
// propagates everywhere the shared store is used).
function dispositionPillsHtml(selected) {
  return dispositionOptions().map(o => `
    <span class="tag-filter-pill${o === selected ? ' active' : ''}" data-dispo="${escHtml(o)}" style="--tag-c:${tagColor(o)}">
      <span class="tag-color-dot" data-dispo-color="${escHtml(o)}" style="background:${tagColor(o)}"></span>${escHtml(o)}
    </span>`).join('');
}
function wireDispositionPills(container, onPick) {
  container.querySelectorAll('[data-dispo]').forEach(el => el.addEventListener('click', () => onPick(el.dataset.dispo)));
  container.querySelectorAll('[data-dispo-color]').forEach(dot => dot.addEventListener('click', e => {
    e.stopPropagation();
    const name = dot.dataset.dispoColor;
    const inp = document.createElement('input');
    inp.type = 'color'; inp.value = tagColor(name);
    inp.addEventListener('input', () => setTagColor(name, inp.value));
    inp.addEventListener('change', () => onPick(null)); // re-render pills with the new color, keep selection
    inp.click();
  }));
}

let leadFormDisposition = ''; // picker state for the open lead form

function renderLeadEditor(d, isNew) {
  const area = document.getElementById('lead-editor-area');
  leadFormDisposition = d.disposition || '';
  area.innerHTML = `
    <div class="daily-task-form">
      <div class="daily-task-form-head">
        <input type="text" id="lead-business-name" placeholder="Business name" value="${escHtml(d.business_name || '')}">
        <select id="lead-status">
          ${['active', 'won', 'lost', 'dormant'].map(s => `<option value="${s}"${d.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
      </div>
      ${leadFieldRow('Contact name', 'lead-contact-name', d.contact_name)}
      ${leadFieldRow('Phone', 'lead-phone', d.phone_number, 'tel')}
      ${leadFieldRow('Website', 'lead-website', d.website)}
      ${leadFieldRow('Primary email', 'lead-email', d.primary_email, 'email')}
      ${leadFieldRow('Address', 'lead-address', d.address)}
      ${leadFieldRow('City', 'lead-city', d.city)}
      ${leadFieldRow('Niche', 'lead-niche', d.niche)}
      ${leadFieldRow('Source', 'lead-source', d.source)}
      <div class="expense-field-row">
        <label>Disposition</label>
        <div class="tags-bar" id="lead-dispo-pills" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
      </div>
      ${renderLeadScoreCard(d.notes)}
      <div class="expense-field-row">
        <label>Notes</label>
        <textarea id="lead-notes" style="min-height:70px;">${escHtml(d.notes || '')}</textarea>
      </div>
      <div class="daily-task-form-actions">
        ${isNew ? '' : '<button class="del-task-btn" id="lead-delete-btn">Delete lead</button>'}
        <button class="save-btn" id="lead-save-btn">${isNew ? 'Create lead' : 'Save'}</button>
      </div>
    </div>
    ${isNew ? '' : '<div id="lead-timeline"></div>'}
  `;
  renderLeadDispoPills();
  document.getElementById('lead-save-btn').addEventListener('click', () => isNew ? createLead() : saveLead());
  document.getElementById('lead-delete-btn')?.addEventListener('click', deleteCurrentLead);
  if (isNew) document.getElementById('lead-business-name').addEventListener('blur', autofillLeadFromProspect);
  if (!isNew) renderLeadTimeline();
}

// Manually adding a lead that was already dialed as a prospect shouldn't mean
// retyping what the dialer already knows — match by exact name (case-
// insensitive) against every prospect ever imported, fill only the fields
// still blank (never overwrite something the user already typed).
function autofillLeadFromProspect() {
  const nameEl = document.getElementById('lead-business-name');
  const name = nameEl?.value.trim().toLowerCase();
  if (!name) return;
  const p = allProspects.find(x => (x.name || '').trim().toLowerCase() === name);
  if (!p) return;
  const fill = (id, val) => { const el = document.getElementById(id); if (el && !el.value.trim() && val) el.value = val; };
  const websiteMatch = (p.notes || '').match(/Website:\s*([^|]*)\|/);
  fill('lead-website', websiteMatch ? websiteMatch[1].trim() : '');
  fill('lead-phone', p.phone);
  fill('lead-email', p.email);
  fill('lead-city', p.city);
  fill('lead-niche', p.niche);
  fill('lead-source', p.source);
  const notesEl = document.getElementById('lead-notes');
  if (notesEl && !notesEl.value.trim() && p.notes) notesEl.value = p.notes;
  toast('Filled in from prospect list');
}

function renderLeadDispoPills() {
  const wrap = document.getElementById('lead-dispo-pills');
  if (!wrap) return;
  wrap.innerHTML = dispositionPillsHtml(leadFormDisposition);
  wireDispositionPills(wrap, pick => {
    if (pick !== null) leadFormDisposition = pick === leadFormDisposition ? '' : pick; // click again to clear
    renderLeadDispoPills();
  });
}

function readLeadForm() {
  return {
    business_name: document.getElementById('lead-business-name').value.trim() || 'Untitled lead',
    status: document.getElementById('lead-status').value,
    contact_name: document.getElementById('lead-contact-name').value.trim(),
    phone_number: document.getElementById('lead-phone').value.trim(),
    website: document.getElementById('lead-website').value.trim(),
    primary_email: document.getElementById('lead-email').value.trim(),
    address: document.getElementById('lead-address').value.trim(),
    city: document.getElementById('lead-city').value.trim(),
    niche: document.getElementById('lead-niche').value.trim(),
    source: document.getElementById('lead-source').value.trim(),
    disposition: leadFormDisposition,
    notes: document.getElementById('lead-notes').value,
  };
}

async function createLead() {
  try {
    const created = await apiCall('POST', '/leads', readLeadForm());
    toast('Lead created');
    await loadLeads();
    openLead(created.id);
  } catch (e) { toast('Could not create: ' + (String(e.message || '').match(/"error":"([^"]+)"/)?.[1] || 'check connection')); }
}

async function saveLead() {
  if (!currentLeadId) return;
  try {
    await apiCall('PUT', '/leads/' + currentLeadId, readLeadForm());
    toast('Saved');
    await loadLeads();
    currentLead = await apiCall('GET', '/leads/' + currentLeadId);
    renderLeadsList();
    updateCrmHeader();
  } catch (e) { toast('Could not save: ' + (String(e.message || '').match(/"error":"([^"]+)"/)?.[1] || 'check connection')); }
}

async function deleteCurrentLead() {
  if (!currentLeadId) return;
  if (!confirm('Delete this lead? Linked audits/follow-ups/replies stay — they just become unlinked.')) return;
  const id = currentLeadId;
  try { await apiCall('DELETE', '/leads/' + id); } catch (e) {}
  leads = leads.filter(l => l.id !== id);
  currentLeadId = null; currentLead = null; leadsView = 'empty'; crmSubTab = 'overview';
  renderLeadsList();
  updateCrmHeader(); showCrmSub('overview');
  document.getElementById('lead-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">Select a lead, or hit + to add one.</div>`;
}

function leadTimelineRowHtml(item) {
  const unlinkBtn = `<button class="cancel-sel-btn" data-unlink="${item.id}" data-unlink-type="${item.kind}">Unlink</button>`;
  if (item.kind === 'audit') {
    return `<div class="lead-timeline-row" data-open-audit="${item.id}">
      <span class="lead-timeline-type">Audit</span>
      <span class="lead-timeline-label">${escHtml(item.business_name)} · ${escHtml(item.status)}</span>
      <span class="lead-timeline-date">${fmtDate(item.ts)}</span>
      ${unlinkBtn}
    </div>`;
  }
  if (item.kind === 'followup') {
    return `<div class="lead-timeline-row" data-open-followup="${item.id}">
      <span class="lead-timeline-type">Follow-up</span>
      <span class="lead-timeline-label">${escHtml(item.next_label || 'All touches sent')}</span>
      <span class="lead-timeline-date">${fmtDate(item.ts)}</span>
      ${unlinkBtn}
    </div>`;
  }
  // Reply rows expand inline on click (rfy-crm §7.3 — the shipped hub gave
  // no way to actually read a reply). preview is everything the DB stores
  // (Instantly's content_preview), so this IS the full available content.
  return `<div class="lead-timeline-row lead-timeline-reply" data-reply-toggle="${item.id}">
    <span class="lead-timeline-type">Reply</span>
    <span class="lead-timeline-label">${escHtml(item.from_name || item.from_email)}: ${escHtml(item.subject || '')}</span>
    <span class="lead-timeline-date">${fmtDate(item.ts)}</span>
    ${unlinkBtn}
  </div>
  <div class="lead-reply-detail hidden" id="reply-detail-${item.id}">
    <div class="lead-reply-meta">${escHtml(item.from_name || '')} &lt;${escHtml(item.from_email || '')}&gt;${item.campaign_name ? ' · ' + escHtml(item.campaign_name) : ''}</div>
    <div class="lead-reply-subject">${escHtml(item.subject || '(no subject)')}</div>
    <div class="lead-reply-body">${escHtml(item.preview || '(no preview stored)')}</div>
  </div>`;
}

function renderLeadTimeline() {
  const wrap = document.getElementById('lead-timeline');
  if (!wrap || !currentLead) return;
  const items = [
    ...currentLead.audits.map(a => ({ kind: 'audit', ts: a.updated_at, ...a })),
    ...currentLead.followups.map(f => ({ kind: 'followup', ts: f.updated_at, ...f })),
    ...currentLead.replies.map(r => ({ kind: 'reply', ts: r.timestamp_email, ...r })),
  ].sort((a, b) => b.ts - a.ts);
  wrap.innerHTML = `<div class="audit-section-title">Timeline</div>` +
    (items.length ? items.map(leadTimelineRowHtml).join('')
      : '<div style="padding:8px 0;color:#444;font-size:12px;">Nothing linked yet — link items from the Unmatched list.</div>');
  wrap.querySelectorAll('[data-open-audit]').forEach(el => el.addEventListener('click', () => switchCrmSub('audit', el.dataset.openAudit)));
  wrap.querySelectorAll('[data-open-followup]').forEach(el => el.addEventListener('click', () => switchCrmSub('followup', el.dataset.openFollowup)));
  wrap.querySelectorAll('[data-reply-toggle]').forEach(el => el.addEventListener('click', () =>
    document.getElementById('reply-detail-' + el.dataset.replyToggle)?.classList.toggle('hidden')));
  wrap.querySelectorAll('[data-unlink]').forEach(el => el.addEventListener('click', async e => {
    e.stopPropagation();
    try { await apiCall('POST', '/leads/' + currentLeadId + '/unlink', { type: el.dataset.unlinkType, id: el.dataset.unlink }); toast('Unlinked'); openLead(currentLeadId); }
    catch (e) { toast('Could not unlink'); }
  }));
}

function renderUnmatchedView() {
  const area = document.getElementById('lead-editor-area');
  const u = leadUnmatched || { audits: [], followups: [], replies: [] };
  function section(title, arr, type, labelFn) {
    if (!arr.length) return '';
    return `<div class="audit-section-title">${title}</div>` + arr.map(x => `
      <div class="lead-timeline-row">
        <span class="lead-timeline-label">${escHtml(labelFn(x))}</span>
        <button class="cancel-sel-btn" data-attach="${x.id}" data-attach-type="${type}">Attach to lead…</button>
        <button class="cancel-sel-btn" data-newlead="${x.id}" data-newlead-type="${type}" data-newlead-name="${escHtml(labelFn(x))}">New lead</button>
        <button class="cancel-sel-btn" data-dismiss="${x.id}" data-dismiss-type="${type}" title="Delete — not useful, don't want to link it">🗑</button>
      </div>`).join('');
  }
  const empty = !u.audits.length && !u.followups.length && !u.replies.length;
  area.innerHTML = `
    <div class="daily-task-form">
      <div class="audit-section-title" style="margin-top:0;">Unmatched</div>
      ${section('Audits', u.audits, 'audit', x => x.business_name)}
      ${section('Follow-ups', u.followups, 'followup', x => x.business_name || x.lead_name)}
      ${section('Replies', u.replies, 'reply', x => (x.from_name || x.from_email) + ' — ' + (x.subject || ''))}
      ${empty ? '<div style="padding:8px 0;color:#444;font-size:12px;">Nothing unmatched.</div>' : ''}
    </div>`;
  area.querySelectorAll('[data-attach]').forEach(btn => btn.addEventListener('click', () => attachToExistingLead(btn.dataset.attachType, btn.dataset.attach)));
  area.querySelectorAll('[data-newlead]').forEach(btn => btn.addEventListener('click', () => createLeadFromUnmatched(btn.dataset.newleadType, btn.dataset.newlead, btn.dataset.newleadName)));
  area.querySelectorAll('[data-dismiss]').forEach(btn => btn.addEventListener('click', () => dismissUnmatched(btn.dataset.dismissType, btn.dataset.dismiss)));
}

const UNMATCHED_DELETE_ROUTE = { audit: '/audits/', followup: '/followups/', reply: '/replies/' };
async function dismissUnmatched(type, id) {
  if (!confirm('Delete this permanently?')) return;
  try {
    await apiCall('DELETE', UNMATCHED_DELETE_ROUTE[type] + id);
    toast('Deleted');
    openUnmatched();
  } catch (e) { toast('Could not delete'); }
}

async function attachToExistingLead(type, id) {
  const name = prompt('Lead business name to search for:');
  if (name === null) return;
  const match = leads.find(l => (l.business_name || '').toLowerCase().includes(name.trim().toLowerCase()));
  if (!match) { toast('No matching lead found — try "New lead" instead'); return; }
  try {
    await apiCall('POST', '/leads/' + match.id + '/link', { type, id });
    toast('Linked to ' + match.business_name);
    await loadLeads();
    openUnmatched();
  } catch (e) { toast('Could not link'); }
}

async function createLeadFromUnmatched(type, id, name) {
  try {
    const created = await apiCall('POST', '/leads', { business_name: name || 'Untitled lead' });
    await apiCall('POST', '/leads/' + created.id + '/link', { type, id });
    toast('Lead created and linked');
    await loadLeads();
    openLead(created.id);
  } catch (e) { toast('Could not create lead'); }
}

// ── CRM sub-tabs: Audit / Follow-up / Calls (rfy-crm §5) ─────────────────
// Each shows the most recent item by default with older ones as history rows
// and "+ New" always available (§7.1). The editors themselves are the same
// full-size editors the standalone tabs had — only the scoping is new.

function crmHistoryRowHtml(kind, x) {
  const label = kind === 'audit'
    ? `${escHtml(x.business_name)} · ${escHtml(x.status)} · ${x.report_type === 'ads' ? 'Google Ads' : 'Local SEO'}`
    : `${escHtml(x.next_label ? 'Next: ' + x.next_label : 'All touches sent')} · ${escHtml(x.status)}`;
  return `<div class="crm-history-row" data-open="${x.id}">
    <span class="lead-timeline-label">${label}</span>
    <span class="lead-timeline-date">${fmtDate(x.updated_at)}</span>
  </div>`;
}

function renderCrmAuditSub(preferId) {
  const bar = document.getElementById('crm-audit-history');
  const list = currentLead?.audits || [];
  bar.innerHTML = `<button class="audit-add-btn" id="crm-new-audit-btn">+ New audit</button>` +
    list.map(a => crmHistoryRowHtml('audit', a)).join('');
  bar.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openAudit(el.dataset.open)));
  document.getElementById('crm-new-audit-btn').addEventListener('click', newAuditForLead);
  const openId = preferId || list[0]?.id;
  if (openId) { openAudit(openId); }
  else {
    currentAuditId = null; currentAudit = null;
    document.getElementById('audit-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">No audits for this lead yet — hit + New audit.</div>`;
  }
}

// New audits are always born from a lead: lead_id set from context,
// business_name (and website/city/niche) pre-filled from the parent so the
// two can never drift (§1.9 — the editor also locks the name field).
async function newAuditForLead() {
  if (!currentLead) return;
  const data = emptyAuditData();
  data.identity.business_name = currentLead.business_name || '';
  data.identity.website = currentLead.website || '';
  data.identity.city = currentLead.city || '';
  data.identity.niche = currentLead.niche || '';
  try {
    const created = await apiCall('POST', '/audits', { business_name: currentLead.business_name, data, lead_id: currentLeadId });
    currentLead.audits.unshift({ id: created.id, business_name: created.business_name, status: created.status, report_type: 'seo', updated_at: created.updated_at });
    renderCrmAuditSub(created.id);
  } catch (e) { toast('Could not create audit'); }
}

function renderCrmFollowupSub(preferId) {
  const bar = document.getElementById('crm-followup-history');
  const list = currentLead?.followups || [];
  bar.innerHTML = `
    <span class="crm-history-new">
      <input type="date" id="crm-fu-start" title="Touch 1 date">
      <button class="audit-add-btn" id="crm-new-fu-btn">+ New sequence</button>
    </span>` +
    list.map(f => crmHistoryRowHtml('followup', f)).join('');
  document.getElementById('crm-fu-start').value = dpToIso(new Date());
  bar.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openFollowup(el.dataset.open)));
  document.getElementById('crm-new-fu-btn').addEventListener('click', newFollowupForLead);
  const openId = preferId || list[0]?.id;
  if (openId) { openFollowup(openId); }
  else {
    currentFollowupId = null; followupDraft = null;
    document.getElementById('followup-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">No follow-up sequences for this lead yet — pick a touch-1 date and hit + New sequence.</div>`;
  }
}

async function newFollowupForLead() {
  if (!currentLead) return;
  const start_at = document.getElementById('crm-fu-start')?.valueAsDate?.getTime() || Date.now();
  try {
    const created = await apiCall('POST', '/followups', {
      lead_name: currentLead.contact_name || '',
      business_name: currentLead.business_name || 'Untitled follow-up',
      start_at, lead_id: currentLeadId,
    });
    const next = created.data.touches[0];
    currentLead.followups.unshift({ id: created.id, lead_name: created.lead_name, business_name: created.business_name, status: created.status, updated_at: created.updated_at, next_due_at: next.due_at, next_label: next.label });
    renderCrmFollowupSub(created.id);
    toast('Sequence created');
  } catch (e) { toast('Could not create sequence'); }
}

// The dial pad is ONE DOM subtree (#dialer-area) that moves between the
// standalone Dialer tab and a lead's Calls sub-tab — where it currently
// lives IS the dialing context (lead-scoped vs free dial).
function dialerInCrm() {
  return !!document.getElementById('crm-calls-sub')?.contains(document.getElementById('dialer-area'));
}
function moveDialerTo(containerId) {
  const area = document.getElementById('dialer-area');
  const home = document.getElementById(containerId);
  if (area && home && area.parentElement !== home) home.appendChild(area);
}

function renderCrmCallsSub() {
  moveDialerTo('crm-calls-sub');
  // Phone box pre-filled from the lead (editable — edits save back, §1.6).
  const inp = document.getElementById('dial-number');
  if (inp && !twCall && !twDialing) inp.value = currentLead?.phone_number || '';
  renderCallLog();
  renderSmsLog();
  initDialer();
  loadUsagePanel();
}

// Standalone Dialer tab (v162): free dialing like the pre-CRM Calls tab.
// A typed number that matches a lead's phone still links the call (and gets
// the disposition picker) — an unknown number just logs unlinked.
async function loadDialerTab() {
  moveDialerTo('dialer-home');
  if (!leads.length) { try { leads = await apiCall('GET', '/leads'); } catch (e) {} } // for name chips + auto-link
  renderCallLog();
  renderSmsLog();
  initDialer();
  loadUsagePanel();
  loadProspectLists();
  if (currentProspectListId) openProspectList(currentProspectListId); else renderProspectListView();
  loadProspectStatsForDate(prospectStatsDate || laTodayStr());
}

// Typing a number for a lead that had none (or correcting one) persists it
// on the lead — the change listener is wired once at startup, and only fires
// while a lead's Calls sub-tab is the active context.
async function savePhoneBackToLead(raw) {
  if (!currentLeadId || !currentLead || currentTab !== 'crm' || crmSubTab !== 'calls') return;
  const val = (normalizeDialNumber(raw) || raw).trim();
  if (val === (currentLead.phone_number || '')) return;
  try {
    await apiCall('PUT', '/leads/' + currentLeadId, { phone_number: val });
    currentLead.phone_number = val;
    const row = leads.find(l => l.id === currentLeadId); if (row) row.phone_number = val;
    toast('Phone saved to lead');
  } catch (e) { toast('Could not save phone to lead'); }
}

// ── Prospect lists (Dialer tab) ──────────────────────────────────────────
// Lightweight tier below rfy-crm leads: bulk-import a raw dial list, work it
// with a simple per-row outcome, one-click "Promote" carries real signal
// into a full lead. See BUILD-SPEC-prospect-lists.md. No offline support
// (like Expenses/Calendar) — this rides direct apiCall, not the idb path.
const PROSPECT_OUTCOMES = [
  ['booked', 'Booked'],
  ['bad_fit', 'Disqualified'],
  ['follow_up_later', 'Follow up later'],
  ['gatekeeper', 'Gatekeeper'],
  ['interested', 'Interested'],
  ['no_answer', 'No answer'],
  ['not_interested', 'Not interested'],
  ['not_yet_called', 'Not yet called'],
  ['voicemail', 'Voicemail'],
];
let prospectLists = [];          // rollup rows: {..., count, by_outcome}
let currentProspectListId = null;
let currentProspectList = null;  // full record incl. prospects[] from GET /prospect-lists/:id
let lastDialedProspectId = null; // highlighted row — set on Dial, cleared only by dialing another
const openProspectNotesIds = new Set(); // ids with the score/notes panel expanded — survives re-renders
const pendingProspectOutcomes = {}; // id -> outcome not yet confirmed by a sync payload, wins over stale ones
const selectedProspects = new Set(); // bulk-select state — survives re-renders same as openProspectNotesIds
let lastClickedProspectId = null;    // shift-click range anchor, mirrors the expenses list pattern
let activeProspectOutcomeFilter = null; // outcome key, or null = show all
let dialingProspectId = null;    // one-shot: set by dialProspect(), read+cleared by startCall()
let prospectStatsDate = null;    // null = viewing "today" (live via sync); 'YYYY-MM-DD' = a frozen past day

async function loadProspectLists() {
  try { prospectLists = await apiCall('GET', '/prospect-lists'); } catch (e) { return; }
  renderProspectListsPanel();
}

function renderProspectListsPanel() {
  const area = document.getElementById('prospect-lists');
  if (!area) return;
  const rows = prospectLists.map(l => {
    const summary = PROSPECT_OUTCOMES
      .filter(([k]) => l.by_outcome && l.by_outcome[k])
      .map(([k, label]) => `${l.by_outcome[k]} ${label.toLowerCase()}`)
      .join(', ') || 'empty';
    return `<div class="note-item${l.id === currentProspectListId ? ' active' : ''}" data-id="${l.id}">
      <div class="note-item-title">${escHtml(l.name)}</div>
      <div class="note-item-snippet">${l.count} prospect${l.count === 1 ? '' : 's'} — ${escHtml(summary)}</div>
    </div>`;
  }).join('') || '<div style="padding:16px 12px;color:#444;font-size:12px;">No prospect lists yet — "+ New list" to start one.</div>';
  area.innerHTML = rows;
  area.querySelectorAll('.note-item[data-id]').forEach(el => el.addEventListener('click', () => openProspectList(el.dataset.id)));
}

async function newProspectList() {
  const name = prompt('List name:');
  if (!name || !name.trim()) return;
  const source = prompt('Source (optional — e.g. "Outscraper local SEO"):') || '';
  let list;
  try { list = await apiCall('POST', '/prospect-lists', { name: name.trim(), source: source.trim() }); }
  catch (e) { toast('Could not create list'); return; }
  await loadProspectLists();
  openProspectList(list.id);
}

async function scrapeNewProspects() {
  const query = prompt('Search phrase (e.g. "roofers near me in Anaheim, California"):');
  if (!query || !query.trim()) return;
  try { await apiCall('POST', '/prospect-lists/scrape', { query: query.trim() }); }
  catch (e) { toast('Could not start scrape'); return; }
  toast("Scrape started — check back in a few minutes, it'll show up in your list picker.");
}

async function jumpToProspect(id) {
  const p = allProspects.find(x => x.id === id);
  if (!p) { toast('Prospect no longer exists'); return; }
  switchTab('dialer');
  openProspectNotesIds.add(id); // so the score/GBP-link panel is already expanded once the list renders
  await openProspectList(p.list_id);
  document.querySelector(`.prospect-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
}

async function openProspectList(id) {
  let list;
  try { list = await apiCall('GET', '/prospect-lists/' + id); } catch (e) { toast('Could not load list'); return; }
  currentProspectListId = id;
  currentProspectList = list;
  selectedProspects.clear(); lastClickedProspectId = null; activeProspectOutcomeFilter = null;
  renderProspectListsPanel();
  renderProspectListView();
  if (isMobile()) closeSidebar();
}

// Parses the pipe-delimited scoring text the Outscraper n8n workflow writes
// into prospects.notes (no dedicated columns for these, deliberately — see
// BUILD-SPEC-prospect-lists.md). Returns null for anything else (manually
// imported rows, plain notes) so the caller falls back to showing raw text.
function parseProspectScore(notes) {
  if (!notes) return null;
  const m = {};
  let mm;
  if ((mm = notes.match(/Website:\s*([^|]*)\|/))) m.website = mm[1].trim();
  if ((mm = notes.match(/Rating:\s*([\d.]+)\s*\((\d+)\s*reviews?\)/))) { m.rating = parseFloat(mm[1]); m.reviews = parseInt(mm[2], 10); }
  if ((mm = notes.match(/Claimed:\s*(Yes|No)/))) m.claimed = mm[1];
  if ((mm = notes.match(/Est\. rank:\s*(\d+)/))) m.rank = parseInt(mm[1], 10);
  if ((mm = notes.match(/Completeness:\s*(\d+)/))) m.completeness = parseInt(mm[1], 10);
  if ((mm = notes.match(/Review Strength:\s*(\d+)/))) m.reviewStrength = parseInt(mm[1], 10);
  if ((mm = notes.match(/Ranking Readiness:\s*(\d+)/))) m.readiness = parseInt(mm[1], 10);
  if ((mm = notes.match(/GBP:\s*(\S+)/))) m.gbpUrl = mm[1].trim();
  if ((mm = notes.match(/Quick wins:\s*([\s\S]+)$/))) m.wins = mm[1].split('|').map(w => w.trim()).filter(Boolean);
  const core = ['rating', 'completeness', 'reviewStrength', 'readiness'];
  if (!core.every(k => typeof m[k] === 'number' && !Number.isNaN(m[k]))) return null;
  return m;
}

function prospectMeterRow(label, val) {
  const pct = Math.max(0, Math.min(100, val));
  return `<div class="prospect-meter-row">
    <span class="prospect-meter-label">${escHtml(label)}</span>
    <div class="prospect-meter-track"><div class="prospect-meter-fill" style="width:${pct}%"></div></div>
    <span class="prospect-meter-val">${val}</span>
  </div>`;
}

const STAR_PATH = 'M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z';

// Full scorecard (gauge + stars + meters + Quick Wins) when notes parses as
// Can-style scoring data; otherwise the plain text block as before.
// Shared scorecard body (gauge + stars + meters + facts + quick wins) — used
// by both the Dialer's click-to-expand row and the CRM lead editor's
// read-only card, so the two never drift out of sync.
function buildScoreCardBody(s) {
  const CIRC = 226.19; // 2 * PI * r36
  const offset = CIRC * (1 - Math.max(0, Math.min(100, s.readiness)) / 100);
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<svg viewBox="0 0 20 20" class="${i < Math.round(s.rating) ? 'on' : ''}"><path d="${STAR_PATH}"/></svg>`).join('');
  const winsHtml = (s.wins || []).map(w => `<li>${escHtml(w)}</li>`).join('');

  return `<div class="prospect-score-top">
      <div class="prospect-gauge-wrap">
        <div class="prospect-gauge">
          <svg width="72" height="72" viewBox="0 0 84 84">
            <circle cx="42" cy="42" r="36" fill="none" stroke="#1e1f22" stroke-width="7"/>
            <circle cx="42" cy="42" r="36" fill="none" stroke="#5fc83b" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="${CIRC}" stroke-dashoffset="${offset}" transform="rotate(-90 42 42)"/>
          </svg>
          <div class="prospect-gauge-num">${s.readiness}</div>
        </div>
        <div class="prospect-gauge-cap">Readiness</div>
      </div>
      <div class="prospect-score-side">
        <div class="prospect-stars-row">
          <span class="prospect-stars">${stars}</span>
          <b>${s.rating.toFixed(1)}</b>
          ${s.reviews != null ? `<span class="prospect-score-faint"> · ${s.reviews} reviews</span>` : ''}
        </div>
        ${prospectMeterRow('Completeness', s.completeness)}
        ${prospectMeterRow('Review strength', s.reviewStrength)}
        <div class="prospect-facts">
          ${s.claimed ? `<span><b>${s.claimed === 'Yes' ? 'Claimed' : 'Unclaimed'}</b></span>` : ''}
          ${s.rank != null ? `<span>Est. rank <b>${s.rank}</b></span>` : ''}
          ${s.website && s.website !== 'None' ? `<a href="${escHtml(s.website)}" target="_blank" rel="noopener">${escHtml(s.website.replace(/^https?:\/\//, ''))} ↗</a>` : ''}
          ${s.gbpUrl ? `<a href="${escHtml(s.gbpUrl)}" target="_blank" rel="noopener">Google Business Profile ↗</a>` : ''}
        </div>
      </div>
    </div>
    ${winsHtml ? `<p class="prospect-wins-label">Quick wins</p><ul class="prospect-wins">${winsHtml}</ul>` : ''}`;
}

function renderProspectScorePanel(p) {
  if (!p.notes) return '';
  const s = parseProspectScore(p.notes);
  if (!s) return `<div class="prospect-row-notes hidden" data-notes-id="${p.id}">${escHtml(p.notes)}</div>`;
  return `<div class="prospect-row-notes prospect-row-notes-scored hidden" data-notes-id="${p.id}">${buildScoreCardBody(s)}</div>`;
}

// Read-only card above the editable Notes textarea on a lead — same scoring
// data as the Dialer's prospect scorecard, carried across on Promote.
function renderLeadScoreCard(notes) {
  const s = parseProspectScore(notes);
  if (!s) return '';
  return `<div class="prospect-row-notes prospect-row-notes-scored lead-score-card">${buildScoreCardBody(s)}</div>`;
}

function renderProspectListView() {
  const el = document.getElementById('prospect-list-view');
  if (!el) return;
  if (!currentProspectList) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const l = currentProspectList;
  const allProspectsInList = l.prospects || [];
  // prune selection of anything no longer in the list (deleted elsewhere, sync tick, etc.)
  const liveIds = new Set(allProspectsInList.map(p => p.id));
  [...selectedProspects].forEach(id => { if (!liveIds.has(id)) selectedProspects.delete(id); });

  const outcomeCounts = {};
  allProspectsInList.forEach(p => { outcomeCounts[p.outcome] = (outcomeCounts[p.outcome] || 0) + 1; });
  const presentOutcomes = PROSPECT_OUTCOMES.filter(([k]) => outcomeCounts[k]);
  if (activeProspectOutcomeFilter && !outcomeCounts[activeProspectOutcomeFilter]) activeProspectOutcomeFilter = null;
  const filterBarHtml = presentOutcomes.length >= 2 ? `
    <div class="tags-bar prospect-filter-bar">
      ${presentOutcomes.map(([k, label]) => `
        <span class="tag-filter-pill${activeProspectOutcomeFilter === k ? ' active' : ''}" data-outcome-filter="${k}">${escHtml(label)} (${outcomeCounts[k]})</span>
      `).join('')}
      ${activeProspectOutcomeFilter ? '<span class="tag-filter-clear" data-outcome-filter-clear="1">Clear</span>' : ''}
    </div>` : '';

  const filtered = activeProspectOutcomeFilter
    ? allProspectsInList.filter(p => p.outcome === activeProspectOutcomeFilter)
    : allProspectsInList;

  const anySelected = selectedProspects.size > 0;
  const allFilteredSelected = filtered.length > 0 && filtered.every(p => selectedProspects.has(p.id));

  const rowsHtml = filtered.map(p => {
    const outcomeOpts = PROSPECT_OUTCOMES.map(([k, label]) =>
      `<option value="${k}"${p.outcome === k ? ' selected' : ''}>${escHtml(label)}</option>`).join('');
    const contact = [fmtPhone(p.phone) || p.phone, p.email].filter(Boolean).join(' · ') || '—';
    const promoteBtn = p.promoted_lead_id
      ? `<button class="prospect-promote-btn promoted" data-open-lead="${p.promoted_lead_id}">✓ Lead</button>
         <button class="prospect-unpromote-btn" data-unpromote-id="${p.id}" title="Undo promote — back to a normal prospect">↩</button>`
      : `<button class="prospect-promote-btn" data-promote-id="${p.id}">Promote</button>`;
    const rowClass = [
      p.outcome && p.outcome !== 'not_yet_called' ? 'called' : '',
      p.id === lastDialedProspectId ? 'dialed' : '',
      selectedProspects.has(p.id) ? 'selected' : '',
    ].filter(Boolean).join(' ');
    return `<div class="prospect-row${rowClass ? ' ' + rowClass : ''}" data-id="${p.id}">
      <input type="checkbox" class="prospect-row-check" data-id="${p.id}"${selectedProspects.has(p.id) ? ' checked' : ''}>
      <div class="prospect-row-main" data-toggle-notes="${p.id}">
        <div class="prospect-row-name">${escHtml(p.name || 'Unnamed')}</div>
        <div class="prospect-row-contact">${escHtml(contact)}${p.city ? ' · ' + escHtml(p.city) : ''}</div>
      </div>
      <select class="prospect-outcome-select" data-outcome-id="${p.id}">${outcomeOpts}</select>
      <div class="prospect-row-actions">
        <button class="prospect-dial-btn" data-dial-id="${p.id}"${p.phone ? '' : ' disabled'} title="Dial">📞</button>
        ${promoteBtn}
        <button class="prospect-del-btn" data-del-id="${p.id}" title="Delete row">✕</button>
      </div>
      ${renderProspectScorePanel(p)}
    </div>`;
  }).join('') || (activeProspectOutcomeFilter ? '<div class="agenda-empty">No prospects with this status.</div>' : '<div class="agenda-empty">No prospects yet — Import to add some.</div>');

  el.innerHTML = `
    <div class="prospect-list-header">
      <span class="prospect-list-title">${escHtml(l.name)}${l.source ? ` <span style="color:#555;font-size:11px;font-weight:400;">(${escHtml(l.source)})</span>` : ''}</span>
      <div class="prospect-list-header-actions">
        <button class="del-task-btn prospect-list-rename-btn" id="prospect-list-rename-btn">✏️ Rename</button>
        <button class="del-task-btn" id="prospect-list-del-btn">🗑 Delete list</button>
      </div>
    </div>
    ${filterBarHtml}
    <div class="exp-bulk-bar prospect-bulk-bar${anySelected ? '' : ' hidden'}">
      <label class="prospect-select-all-wrap"><input type="checkbox" class="prospect-select-all"${allFilteredSelected ? ' checked' : ''}> Select all</label>
      <span class="exp-bulk-count">${selectedProspects.size} selected</span>
      <button class="exp-bulk-delete" id="prospect-bulk-delete">Delete selected</button>
      <button class="exp-bulk-clear" id="prospect-bulk-clear">Clear</button>
    </div>
    ${!anySelected && filtered.length ? `<div class="prospect-select-all-row"><label class="prospect-select-all-wrap"><input type="checkbox" class="prospect-select-all"${allFilteredSelected ? ' checked' : ''}> Select all</label></div>` : ''}
    <div id="prospect-rows">${rowsHtml}</div>`;

  el.querySelectorAll('[data-outcome-filter]').forEach(pill =>
    pill.addEventListener('click', () => {
      const k = pill.dataset.outcomeFilter;
      activeProspectOutcomeFilter = activeProspectOutcomeFilter === k ? null : k;
      renderProspectListView();
    }));
  el.querySelector('[data-outcome-filter-clear]')?.addEventListener('click', () => {
    activeProspectOutcomeFilter = null;
    renderProspectListView();
  });

  el.querySelectorAll('[data-outcome-id]').forEach(sel =>
    sel.addEventListener('change', () => updateProspectOutcome(sel.dataset.outcomeId, sel.value)));
  el.querySelectorAll('[data-dial-id]').forEach(btn =>
    btn.addEventListener('click', () => dialProspect(btn.dataset.dialId)));
  el.querySelectorAll('[data-promote-id]').forEach(btn =>
    btn.addEventListener('click', () => promoteProspect(btn.dataset.promoteId)));
  el.querySelectorAll('[data-open-lead]').forEach(btn =>
    btn.addEventListener('click', () => { switchTab('crm'); openLead(btn.dataset.openLead); }));
  el.querySelectorAll('[data-unpromote-id]').forEach(btn =>
    btn.addEventListener('click', () => unpromoteProspect(btn.dataset.unpromoteId)));
  el.querySelectorAll('[data-del-id]').forEach(btn =>
    btn.addEventListener('click', () => deleteProspectRow(btn.dataset.delId)));
  el.querySelectorAll('[data-notes-id]').forEach(panel => {
    if (openProspectNotesIds.has(panel.dataset.notesId)) panel.classList.remove('hidden');
  });
  el.querySelectorAll('[data-toggle-notes]').forEach(main =>
    main.addEventListener('click', () => {
      const id = main.dataset.toggleNotes;
      if (openProspectNotesIds.has(id)) openProspectNotesIds.delete(id); else openProspectNotesIds.add(id);
      document.querySelector(`.prospect-row-notes[data-notes-id="${id}"]`)?.classList.toggle('hidden');
    }));
  document.getElementById('prospect-list-del-btn')?.addEventListener('click', deleteProspectListActive);
  document.getElementById('prospect-list-rename-btn')?.addEventListener('click', renameProspectListActive);

  // Select-all — there may be two checkboxes (bulk bar + empty-state row); keep them in sync
  el.querySelectorAll('.prospect-select-all').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) filtered.forEach(p => selectedProspects.add(p.id));
    else filtered.forEach(p => selectedProspects.delete(p.id));
    renderProspectListView();
  }));

  // Per-row checkboxes — click toggles, shift-click range-selects (mirrors the expenses list)
  el.querySelectorAll('.prospect-row-check').forEach((cb, idx) => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', e => {
      const id = cb.dataset.id;
      if (e.shiftKey && lastClickedProspectId) {
        const lastIdx = filtered.findIndex(x => x.id === lastClickedProspectId);
        if (lastIdx !== -1) {
          const lo = Math.min(idx, lastIdx), hi = Math.max(idx, lastIdx);
          for (let i = lo; i <= hi; i++) selectedProspects.add(filtered[i].id);
          lastClickedProspectId = id;
          renderProspectListView();
          return;
        }
      }
      lastClickedProspectId = id;
      if (cb.checked) selectedProspects.add(id); else selectedProspects.delete(id);
      renderProspectListView();
    });
  });

  document.getElementById('prospect-bulk-delete')?.addEventListener('click', async () => {
    const ids = [...selectedProspects];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} prospect${ids.length !== 1 ? 's' : ''}? This can't be undone.`)) return;
    currentProspectList.prospects = currentProspectList.prospects.filter(p => !selectedProspects.has(p.id));
    selectedProspects.clear(); lastClickedProspectId = null;
    renderProspectListView();
    try { await Promise.all(ids.map(id => apiCall('DELETE', '/prospects/' + id))); }
    catch (e) { toast('Some deletes failed'); }
    loadProspectLists();
  });
  document.getElementById('prospect-bulk-clear')?.addEventListener('click', () => {
    selectedProspects.clear(); lastClickedProspectId = null; renderProspectListView();
  });
}

async function renameProspectListActive() {
  if (!currentProspectListId || !currentProspectList) return;
  const name = prompt('Rename list:', currentProspectList.name);
  if (!name || !name.trim() || name.trim() === currentProspectList.name) return;
  try { await apiCall('PATCH', '/prospect-lists/' + currentProspectListId, { name: name.trim() }); }
  catch (e) { toast('Could not rename list'); return; }
  currentProspectList.name = name.trim();
  renderProspectListView();
  loadProspectLists();
}

async function updateProspectOutcome(id, outcome) {
  const p = currentProspectList?.prospects.find(x => x.id === id);
  if (p) p.outcome = outcome; // optimistic — a sync tick landing mid-request must not revert this
  pendingProspectOutcomes[id] = outcome;
  try {
    await apiCall('PUT', '/prospects/' + id, { outcome });
    await loadProspectLists(); // counts changed
    if (prospectStatsDate === null) loadProspectStatsForDate(laTodayStr()); // instant feedback on today's tally
  } catch (e) { delete pendingProspectOutcomes[id]; toast('Could not update outcome'); renderProspectListView(); }
}

// Daily cold-calling stats bar (v180) — dials, first-dial time, total talk
// time, and per-outcome tally for a single day, all prospect lists combined.
// "Today" stays live via the 2s /api/sync poll; ‹ › browses past days
// (frozen — a real day-by-day log via prospect_outcome_events, not just
// today's current-state snapshot, so history stays answerable).
function laTodayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }

function fmtTalkTime(secs) {
  secs = parseInt(secs, 10) || 0;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

async function loadProspectStatsForDate(dateStr) {
  let stats;
  try { stats = await apiCall('GET', '/prospect-stats?date=' + dateStr); } catch (e) { return; }
  renderProspectStatsBar(stats);
}

function renderProspectStatsBar(stats) {
  const el = document.getElementById('prospect-stats-bar');
  if (!el || !stats) return;
  const viewingToday = stats.date === laTodayStr();
  const startTime = stats.first_dial_at
    ? new Date(stats.first_dial_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '—';
  const dateLabel = viewingToday ? 'Today'
    : new Date(stats.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const outcomeChips = PROSPECT_OUTCOMES
    .filter(([k]) => k !== 'not_yet_called' && stats.by_outcome[k])
    .map(([k, label]) => `<div class="pstat-chip"><span class="pstat-chip-num">${stats.by_outcome[k]}</span> ${escHtml(label)}</div>`)
    .join('') || '<div class="pstat-empty">Nothing marked yet</div>';
  el.innerHTML = `
    <div class="pstat-header">
      <button class="pstat-nav-btn" id="pstat-prev" title="Previous day">‹</button>
      <span class="pstat-date">${dateLabel}</span>
      <button class="pstat-nav-btn" id="pstat-next"${viewingToday ? ' disabled' : ''} title="Next day">›</button>
      ${viewingToday ? '' : '<button class="pstat-today-btn" id="pstat-today">Today</button>'}
    </div>
    <div class="pstat-row">
      <div class="pstat-tile"><div class="pstat-num">${stats.dial_count}</div><div class="pstat-label">Dials</div></div>
      <div class="pstat-tile"><div class="pstat-num">${startTime}</div><div class="pstat-label">Start</div></div>
      <div class="pstat-tile"><div class="pstat-num">${fmtTalkTime(stats.talk_seconds)}</div><div class="pstat-label">Talk time</div></div>
    </div>
    <div class="pstat-chips">${outcomeChips}</div>`;
  document.getElementById('pstat-prev')?.addEventListener('click', () => shiftProspectStatsDay(stats.date, -1));
  document.getElementById('pstat-next')?.addEventListener('click', () => shiftProspectStatsDay(stats.date, 1));
  document.getElementById('pstat-today')?.addEventListener('click', () => { prospectStatsDate = null; loadProspectStatsForDate(laTodayStr()); });
}

function shiftProspectStatsDay(fromDate, delta) {
  const d = new Date(fromDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const next = d.toLocaleDateString('en-CA');
  prospectStatsDate = next === laTodayStr() ? null : next;
  loadProspectStatsForDate(next);
}

// Reuses the exact same call path as the standalone Dialer — fill the number,
// call startCall(). No second call path (auto-link-by-phone-match, recording,
// disposition picker all already work unchanged).
function dialProspect(id) {
  const p = currentProspectList?.prospects.find(x => x.id === id);
  if (!p || !p.phone) return;
  const inp = document.getElementById('dial-number');
  if (inp) inp.value = p.phone;
  lastDialedProspectId = id;
  dialingProspectId = id;
  renderProspectListView();
  startCall();
}

async function promoteProspect(id) {
  let lead;
  try { lead = await apiCall('POST', '/prospects/' + id + '/promote'); }
  catch (e) { toast(e.message || 'Could not promote'); return; }
  toast('Promoted to lead: ' + (lead.business_name || 'Untitled lead'));
  const p = currentProspectList?.prospects.find(x => x.id === id);
  if (p) p.promoted_lead_id = lead.id;
  renderProspectListView();
  if (confirm('Open the new lead now?')) { switchTab('crm'); openLead(lead.id); }
}

// Only clears the prospect's own promoted flag — never touches the lead
// (covers both "I promoted too soon" and "I already deleted that lead from
// CRM and this row is just stuck showing ✓ Lead").
async function unpromoteProspect(id) {
  try { await apiCall('POST', '/prospects/' + id + '/unpromote'); }
  catch (e) { toast('Could not undo promote'); return; }
  const p = currentProspectList?.prospects.find(x => x.id === id);
  if (p) p.promoted_lead_id = null;
  renderProspectListView();
  toast('Back to a normal prospect');
}

async function deleteProspectRow(id) {
  if (!confirm('Delete this prospect row?')) return;
  try { await apiCall('DELETE', '/prospects/' + id); }
  catch (e) { toast('Could not delete'); return; }
  if (currentProspectList) currentProspectList.prospects = currentProspectList.prospects.filter(x => x.id !== id);
  renderProspectListView();
  loadProspectLists();
}

async function deleteProspectListActive() {
  if (!currentProspectListId) return;
  if (!confirm('Delete this entire list and all its prospects? This can\'t be undone.')) return;
  try { await apiCall('DELETE', '/prospect-lists/' + currentProspectListId); }
  catch (e) { toast('Could not delete list'); return; }
  currentProspectListId = null; currentProspectList = null;
  renderProspectListView();
  loadProspectLists();
}

function openProspectImportModal() {
  if (!currentProspectListId) { toast('Pick or create a list first'); return; }
  const ta = document.getElementById('prospect-import-csv');
  if (ta) ta.value = '';
  document.getElementById('prospect-import-modal').classList.remove('hidden');
}
function closeProspectImportModal() {
  document.getElementById('prospect-import-modal').classList.add('hidden');
}
async function submitProspectImport() {
  const csv = document.getElementById('prospect-import-csv').value.trim();
  if (!csv) { toast('Paste some CSV first'); return; }
  let result;
  try { result = await apiCall('POST', '/prospect-lists/' + currentProspectListId + '/import', { csv }); }
  catch (e) { toast('Import failed'); return; }
  closeProspectImportModal();
  toast(`Imported ${result.imported}, skipped ${result.skipped}`);
  await openProspectList(currentProspectListId);
  await loadProspectLists();
}

// ── Disposition picker + one-click-through call queue (rfy-crm §1.6/1.7) ──
let dispositionLeadId = null;
let dispositionAdvance = true; // false for inbound callbacks — no queue to advance

function openDispositionModal(leadId, opts) {
  dispositionLeadId = leadId;
  dispositionAdvance = !opts || opts.advance !== false;
  const skipBtn = document.getElementById('disposition-skip');
  if (skipBtn) skipBtn.textContent = dispositionAdvance ? 'Skip → next lead' : 'Skip';
  const modal = document.getElementById('disposition-modal');
  renderDispositionModalPills('');
  document.getElementById('disposition-custom').value = '';
  modal.classList.remove('hidden');
}
function closeDispositionModal() {
  document.getElementById('disposition-modal').classList.add('hidden');
  dispositionLeadId = null;
}
function renderDispositionModalPills(selected) {
  const wrap = document.getElementById('disposition-pills');
  wrap.innerHTML = dispositionPillsHtml(selected);
  wireDispositionPills(wrap, pick => { if (pick !== null) pickDisposition(pick); else renderDispositionModalPills(selected); });
}
async function pickDisposition(value) {
  const leadId = dispositionLeadId;
  const advance = dispositionAdvance;
  closeDispositionModal();
  try {
    await apiCall('PUT', '/leads/' + leadId, { disposition: value });
    const row = leads.find(l => l.id === leadId); if (row) row.disposition = value;
    if (currentLead && currentLeadId === leadId) currentLead.disposition = value;
    renderLeadsList();
    toast('Marked ' + value);
  } catch (e) { toast('Could not save disposition'); }
  if (advance) advanceToNextLead(leadId);
}

// Auto-advance to the next lead in the CURRENT list ordering (the in-memory
// leads array — same order the left list renders). Deliberately NOT
// auto-dialing: you still click Call yourself every time (§1.6). No wrap at
// the end of the list — ponytail: wrap-around dialing loops are how you call
// someone twice by accident.
function advanceToNextLead(fromLeadId) {
  const idx = leads.findIndex(l => l.id === fromLeadId);
  const next = idx >= 0 ? leads[idx + 1] : null;
  if (!next) { toast('End of the leads list'); return; }
  if (currentTab !== 'crm') switchTab('crm');
  openLead(next.id, 'calls');
}

// ── Audits ───────────────────────────────────────────────────
// Data blob shape mirrors AUTOMATED_AUDITS/input_template.json: identity,
// current_situation, findings (each with sources), heatmaps, gsc, narrative.
// The form below is the source of truth; the iframe just renders it via the
// server's /api/audits/render (same audit_render.js the report PDF pipeline
// uses), including that template's own contenteditable + "Export as PDF"
// button — clicking Export inside the preview prints just that iframe.
let audits = [];
let currentAuditId = null;
let currentAudit = null; // full record: {id, business_name, status, data, updated_at}
let saveAuditTimer = null;
let previewAuditTimer = null;

function emptyAuditData() {
  return {
    report_type: 'seo',
    identity: { business_name: '', website: '', city: '', niche: '', primary_keyword: '' },
    current_situation: [
      { label: 'Star rating', value: '' },
      { label: 'Google reviews', value: '' },
      { label: 'Primary category', value: '' },
      { label: 'Average ranking', value: '', link: '' },
    ],
    findings: [{ area: '', status: 'red', finding: '', sources: [{ label: '', url: '' }] }],
    heatmaps: [],
    gsc: { available: false, top_queries: [], notes: '' },
    narrative: { wiifm_hook: '', biggest_opportunity: '', closing_cta: '' },
  };
}

function auditPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i];
    if (cur[k] == null) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[k];
  }
  return { obj: cur, key: /^\d+$/.test(parts[parts.length - 1]) ? +parts[parts.length - 1] : parts[parts.length - 1] };
}
function setAuditPath(root, path, value) {
  const { obj, key } = auditPath(root, path);
  obj[key] = value;
}

async function loadAudits() {
  try { audits = await apiCall('GET', '/audits'); } catch (e) { toast('Could not load audits'); return; }
  renderAuditsList();
}

function renderAuditsList() {
  const area = document.getElementById('audits-list');
  if (!area) return;
  if (!audits.length) { area.innerHTML = '<div class="note-item-snippet" style="padding:8px 12px;">No audits yet.</div>'; return; }
  area.innerHTML = audits.map(a => `
    <div class="audit-item${a.id === currentAuditId ? ' active' : ''}" data-id="${a.id}">
      <div class="audit-item-name">${escHtml(a.business_name || 'Untitled audit')}</div>
      <div class="audit-item-meta">
        <span class="audit-status-pill${a.status === 'sent' ? ' status-sent' : ''}">${escHtml(a.status)}</span>
        <span class="audit-type-pill">${a.report_type === 'ads' ? 'Google Ads' : 'Local SEO'}</span>
        <span>${fmtDate(a.updated_at)}</span>
      </div>
    </div>`).join('');
  area.querySelectorAll('.audit-item').forEach(el => el.addEventListener('click', () => openAudit(el.dataset.id)));
}

// (The old lead-less newAudit() was deleted in rfy-crm — audits are always
// created from inside a lead now via newAuditForLead, and the server 400s a
// POST without a live lead_id.)

async function openAudit(id) {
  try { currentAudit = await apiCall('GET', '/audits/' + id); } catch (e) { toast('Could not load audit'); return; }
  currentAuditId = id;
  renderAuditsList();
  renderAuditEditor();
  if (isMobile()) closeSidebar();
}

async function deleteCurrentAudit() {
  if (!currentAuditId) return;
  if (!confirm('Delete this audit?')) return;
  const id = currentAuditId;
  audits = audits.filter(a => a.id !== id);
  currentAuditId = null; currentAudit = null;
  renderAuditsList();
  document.getElementById('audit-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">Select an audit, or hit + to start a new one.</div>`;
  try { await apiCall('DELETE', '/audits/' + id); } catch (e) {}
}

function auditFieldRow(label, path, value, opts) {
  opts = opts || {};
  const tag = opts.textarea ? 'textarea' : 'input';
  const attrs = opts.textarea ? '' : ` type="text"`;
  const val = opts.textarea ? escHtml(value || '') : '';
  const valueAttr = opts.textarea ? '' : ` value="${escHtml(value || '')}"`;
  return `<div class="audit-field-row">
    <label>${escHtml(label)}</label>
    <${tag}${attrs} data-path="${path}" placeholder="${escHtml(opts.placeholder || '')}"${valueAttr}>${val}</${tag}>
  </div>`;
}

function auditSituationRowHtml(r, i) {
  return `<div class="audit-array-row" data-row="current_situation.${i}">
    <div class="audit-array-row-head">
      <input type="text" data-path="current_situation.${i}.label" placeholder="Label" value="${escHtml(r.label || '')}">
      <input type="text" data-path="current_situation.${i}.value" placeholder="Value" value="${escHtml(r.value || '')}">
      <input type="text" data-path="current_situation.${i}.link" placeholder="Link (optional)" value="${escHtml(r.link || '')}">
      <button class="audit-remove-btn" data-remove="current_situation.${i}">✕</button>
    </div>
  </div>`;
}

function auditFindingRowHtml(f, i) {
  const sources = (f.sources || []).map((s, j) => `
    <div class="audit-source-row" data-row="findings.${i}.sources.${j}">
      <input type="text" data-path="findings.${i}.sources.${j}.label" placeholder="Source label" value="${escHtml(s.label || '')}">
      <input type="text" data-path="findings.${i}.sources.${j}.url" placeholder="URL (optional)" value="${escHtml(s.url || '')}">
      <button class="audit-remove-btn" data-remove="findings.${i}.sources.${j}">✕</button>
    </div>`).join('');
  return `<div class="audit-array-row" data-row="findings.${i}">
    <div class="audit-array-row-head">
      <input type="text" data-path="findings.${i}.area" placeholder="Area (e.g. NAP consistency)" value="${escHtml(f.area || '')}">
      <select data-path="findings.${i}.status">
        <option value="red"${f.status === 'red' ? ' selected' : ''}>Red</option>
        <option value="yellow"${f.status === 'yellow' ? ' selected' : ''}>Yellow</option>
        <option value="green"${f.status === 'green' ? ' selected' : ''}>Green</option>
      </select>
      <button class="audit-remove-btn" data-remove="findings.${i}">✕</button>
    </div>
    <textarea data-path="findings.${i}.finding" placeholder="Finding text" style="margin-top:8px;width:100%;min-height:44px;background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:6px 10px;font-size:13px;color:#e0e0e0;font-family:inherit;">${escHtml(f.finding || '')}</textarea>
    <div class="audit-sources-list">
      ${sources}
      <button class="audit-add-btn" data-add="findings.${i}.sources">+ Source</button>
    </div>
  </div>`;
}

function auditHeatmapRowHtml(h, i) {
  return `<div class="audit-array-row" data-row="heatmaps.${i}">
    <div class="audit-array-row-head">
      ${h.image ? `<img class="audit-heatmap-thumb" src="${escHtml(h.image)}">` : ''}
      <input type="text" data-path="heatmaps.${i}.keyword" placeholder="Keyword" value="${escHtml(h.keyword || '')}">
      <input type="text" data-path="heatmaps.${i}.link" placeholder="LocalRankGuru link (optional)" value="${escHtml(h.link || '')}">
      <label class="audit-add-btn" style="cursor:pointer;">Upload image<input type="file" accept="image/*" data-upload="heatmaps.${i}.image" style="display:none;"></label>
      <button class="audit-remove-btn" data-remove="heatmaps.${i}">✕</button>
    </div>
  </div>`;
}

function auditQueryRowHtml(q, i) {
  return `<div class="audit-array-row" data-row="gsc.top_queries.${i}">
    <div class="audit-array-row-head">
      <input type="text" data-path="gsc.top_queries.${i}.query" placeholder="Query" value="${escHtml(q.query || '')}">
      <input type="text" data-path="gsc.top_queries.${i}.clicks" placeholder="Clicks" value="${escHtml(q.clicks || '')}">
      <input type="text" data-path="gsc.top_queries.${i}.position" placeholder="Avg position" value="${escHtml(q.position || '')}">
      <button class="audit-remove-btn" data-remove="gsc.top_queries.${i}">✕</button>
    </div>
  </div>`;
}

function renderAuditEditor() {
  const area = document.getElementById('audit-editor-area');
  if (!currentAudit) return;
  const d = currentAudit.data;
  // Defensive: external producers (e.g. the auto-audit-from-positive-reply
  // script) may omit fields unused by their own render path. Normalize here
  // so the form never throws on a missing array and silently renders blank.
  d.identity = d.identity || {};
  d.narrative = d.narrative || {};
  d.current_situation = d.current_situation || [];
  d.heatmaps = d.heatmaps || [];
  d.findings = d.findings || [];
  d.gsc = d.gsc || { available: false, top_queries: [], notes: '' };
  d.gsc.top_queries = d.gsc.top_queries || [];
  // rfy-crm §1.9: an audit born from a lead keeps business_name locked to the
  // parent lead so the two can never drift via hand-editing in two places.
  const nameLocked = !!currentAudit.lead_id;
  area.innerHTML = `
    <div class="audit-toolbar">
      <input type="text" id="audit-business-name" placeholder="Business name" value="${escHtml(d.identity.business_name || '')}"${nameLocked ? ' disabled title="Locked to the lead\'s business name"' : ''}>
      <select id="audit-status-select">
        ${['draft', 'sent', 'won', 'lost'].map(s => `<option value="${s}"${currentAudit.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <select data-path="report_type">
        <option value="seo"${(d.report_type || 'seo') === 'seo' ? ' selected' : ''}>Local SEO</option>
        <option value="ads"${d.report_type === 'ads' ? ' selected' : ''}>Google Ads</option>
      </select>
      <span class="audit-save-status" id="audit-save-status"></span>
      <button class="danger-btn" id="audit-delete-btn">Delete</button>
    </div>
    <div class="audit-body">
      <div class="audit-form-pane">
        ${auditFieldRow('Website', 'identity.website', d.identity.website)}
        ${auditFieldRow('City', 'identity.city', d.identity.city)}
        ${auditFieldRow('Niche', 'identity.niche', d.identity.niche)}
        ${auditFieldRow('Primary keyword', 'identity.primary_keyword', d.identity.primary_keyword)}

        ${auditFieldRow('WIIFM hook', 'narrative.wiifm_hook', d.narrative.wiifm_hook, { textarea: true })}

        <div class="audit-section-title">Where you stand right now (GBP + ranking)</div>
        ${d.current_situation.map(auditSituationRowHtml).join('')}
        <button class="audit-add-btn" data-add="current_situation">+ Row</button>

        <div class="audit-section-title">Heatmaps</div>
        ${d.heatmaps.map(auditHeatmapRowHtml).join('')}
        <button class="audit-add-btn" data-add="heatmaps">+ Heatmap</button>

        <div class="audit-section-title">Findings</div>
        ${d.findings.map(auditFindingRowHtml).join('')}
        <button class="audit-add-btn" data-add="findings">+ Finding</button>

        <div class="audit-section-title">Biggest opportunity</div>
        ${auditFieldRow('Biggest opportunity', 'narrative.biggest_opportunity', d.narrative.biggest_opportunity, { textarea: true })}

        <div class="audit-section-title">Search Console</div>
        <div class="audit-field-row">
          <label>Available</label>
          <input type="checkbox" id="audit-gsc-available" data-checkbox="gsc.available"${d.gsc.available ? ' checked' : ''} style="flex:0;width:16px;">
        </div>
        ${d.gsc.top_queries.map(auditQueryRowHtml).join('')}
        <button class="audit-add-btn" data-add="gsc.top_queries">+ Query</button>
        ${auditFieldRow('GSC notes', 'gsc.notes', d.gsc.notes, { textarea: true })}

        ${auditFieldRow('Closing CTA', 'narrative.closing_cta', d.narrative.closing_cta, { textarea: true, placeholder: "I can start in 24 hours, or I hand you the checklist and you'll know exactly what to do." })}
      </div>
      <div class="audit-preview-pane">
        <!-- allow-scripts for the template's Export-as-PDF onclick, allow-modals so
             window.print() isn't blocked, allow-popups(-to-escape-sandbox) so the
             source links (target="_blank") actually open. No allow-same-origin: the
             preview gets an opaque origin, so audit text can never reach this page's
             DOM or storage. -->
        <iframe class="audit-preview-frame" id="audit-preview-frame" sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"></iframe>
      </div>
    </div>
  `;
  wireAuditEditorEvents();
  refreshAuditPreview();
}

function wireAuditEditorEvents() {
  const area = document.getElementById('audit-editor-area');

  document.getElementById('audit-business-name').addEventListener('input', e => {
    setAuditPath(currentAudit.data, 'identity.business_name', e.target.value);
    currentAudit.business_name = e.target.value;
    onAuditChanged();
  });
  document.getElementById('audit-status-select').addEventListener('change', e => {
    if (e.target.value === 'sent' && /\[FILL IN:/i.test(JSON.stringify(currentAudit.data))) {
      e.target.value = currentAudit.status;
      toast('Fill in the highlighted numbers before marking this as sent');
      return;
    }
    currentAudit.status = e.target.value;
    onAuditChanged();
  });
  document.getElementById('audit-delete-btn').addEventListener('click', deleteCurrentAudit);

  area.querySelectorAll('[data-path]').forEach(el => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, e => { setAuditPath(currentAudit.data, el.dataset.path, e.target.value); onAuditChanged(); });
  });
  area.querySelectorAll('[data-checkbox]').forEach(el => {
    el.addEventListener('change', e => { setAuditPath(currentAudit.data, el.dataset.checkbox, e.target.checked); onAuditChanged(); });
  });
  area.querySelectorAll('[data-add]').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.add;
      const arrayRef = getAuditArray(currentAudit.data, path);
      const blank = {
        'current_situation': { label: '', value: '', link: '' },
        'findings': { area: '', status: 'red', finding: '', sources: [] },
        'heatmaps': { keyword: '', image: '', link: '' },
        'gsc.top_queries': { query: '', clicks: '', position: '' },
      };
      const subBlank = path.endsWith('.sources') ? { label: '', url: '' } : blank[path];
      arrayRef.push(subBlank);
      onAuditChanged(true);
    });
  });
  area.querySelectorAll('[data-remove]').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.remove;
      const lastDot = path.lastIndexOf('.');
      const arrPath = path.slice(0, lastDot);
      const idx = +path.slice(lastDot + 1);
      getAuditArray(currentAudit.data, arrPath).splice(idx, 1);
      onAuditChanged(true);
    });
  });
  area.querySelectorAll('[data-upload]').forEach(el => {
    el.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      // Embed as a data URI rather than uploading to /uploads: the preview
      // renders in a sandboxed iframe with no allow-same-origin, so it can't
      // carry the auth cookie an /uploads/... image would need — the image
      // would 401 silently. A data URI needs no fetch at all, so it works
      // in the sandboxed preview, the exported PDF, and a prospect opening
      // that PDF with no Workspace login, all the same way.
      const reader = new FileReader();
      reader.onload = () => {
        setAuditPath(currentAudit.data, el.dataset.upload, reader.result);
        onAuditChanged(true);
      };
      reader.onerror = () => toast('Upload failed');
      reader.readAsDataURL(file);
    });
  });
}

function getAuditArray(root, path) {
  const { obj } = auditPath(root, path + '.0');
  return Array.isArray(obj) ? obj : [];
}

function onAuditChanged(rebuild) {
  if (rebuild) { renderAuditEditor(); } // rebuild also re-renders the preview itself
  const status = document.getElementById('audit-save-status');
  if (status) status.textContent = 'Saving…';
  clearTimeout(saveAuditTimer);
  saveAuditTimer = setTimeout(saveCurrentAudit, 600);
  if (!rebuild) {
    clearTimeout(previewAuditTimer);
    previewAuditTimer = setTimeout(refreshAuditPreview, 500);
  }
}

async function saveCurrentAudit() {
  if (!currentAuditId) return;
  const id = currentAuditId;
  try {
    const saved = await apiCall('PUT', '/audits/' + id, {
      business_name: currentAudit.data.identity.business_name || 'Untitled audit',
      status: currentAudit.status,
      data: currentAudit.data,
    });
    const idx = audits.findIndex(a => a.id === id);
    if (idx >= 0) audits[idx] = { id: saved.id, business_name: saved.business_name, status: saved.status, report_type: currentAudit.data.report_type || 'seo', updated_at: saved.updated_at };
    renderAuditsList();
    // Keep the CRM sub-tab's history rows in sync too
    const la = currentLead?.audits?.find(a => a.id === id);
    if (la) { la.status = saved.status; la.report_type = currentAudit.data.report_type || 'seo'; la.updated_at = saved.updated_at; }
    const status = document.getElementById('audit-save-status');
    if (status) status.textContent = 'Saved';
  } catch (e) {
    const status = document.getElementById('audit-save-status');
    if (status) status.textContent = 'Save failed';
  }
}

// The preview iframe is sandboxed without allow-same-origin, so the parent can't read
// or set its scroll position directly (v128's fix used to). The frame reports its scroll
// back by postMessage instead, and each re-render bakes the last value in to restore it.
let auditPreviewScroll = 0;
window.addEventListener('message', (e) => {
  if (e.data && typeof e.data.auditScroll === 'number') auditPreviewScroll = e.data.auditScroll;
});

async function refreshAuditPreview() {
  const frame = document.getElementById('audit-preview-frame');
  if (!frame || !currentAudit) return;
  try {
    const res = await fetch(API + '/audits/render', {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: currentAudit.data }),
    });
    const html = await res.text();
    frame.srcdoc = html + '<script>addEventListener("load",function(){window.scrollTo(0,'
      + auditPreviewScroll + ')});addEventListener("scroll",function(){parent.postMessage({auditScroll:window.scrollY},"*")})<\/script>';
  } catch (e) {}
}


// ── TRW Daily Tasks ─────────────────────────────────────────────
// Paste a prompt block (a source link + repeated **bolded question** lines),
// get a fillable form back, answer inline, save. Same parser handles both a
// fresh blank-answer paste and re-parsing an already-answered file on import.
let dailyTasks = [];
let currentDailyTaskId = null;
let currentDailyTaskCategory = null; // sidebar filter pill
let dailyTaskDraft = null; // { category, task_date, source_url, context, questions: [{question, answer}] }
const DAILY_TASK_CAT_LABELS = { business_masters: 'Business Master', daily_marketing: 'Daily Marketing', daily_seo_task: 'Daily SEO Task' };

// TRW pastes come in three shapes:
// 1. Already-answered .md file: each question is its own **bold** line
//    followed by prose answer — parse bold lines directly, one pair each.
// 2. Fresh Business-Master-style paste: scenario prose, then ONE bold
//    instruction line ("**Answer the questions:**") followed by a bullet
//    list of the real questions. The scenario + that instruction line are
//    context, not a question — only the exploded bullets are real questions.
// 3. Fresh Daily-SEO-Task-style paste: no bold at all, just a literal
//    "QUESTION:" line with the real question directly beneath it. Everything
//    before "QUESTION:" is context.
// Shape 1 vs 2 is disambiguated after parsing: if any pair's answer turns out
// to be pure bullet lines, that pair (and anything before it) is context and
// only the exploded bullets become questions — a real answered pair's answer
// is prose, not bullets-only (rare exception: a genuine question whose
// answer itself IS a list, e.g. "list 10 niches" — that's why the form keeps
// a per-question ✕ to undo a bad split).
function parseQABlock(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let sourceUrl = '';
  if (i < lines.length && /^https?:\/\//.test(lines[i].trim())) { sourceUrl = lines[i].trim(); i++; }

  // Shape 3: literal "QUESTION:" marker, question is the next non-blank line.
  const qMarkerIdx = lines.findIndex((l, idx) => idx >= i && /^\s*QUESTION:?\s*$/i.test(l));
  if (qMarkerIdx !== -1) {
    const context = lines.slice(i, qMarkerIdx).join('\n').replace(/^\n+|\n+$/g, '');
    let qi = qMarkerIdx + 1;
    while (qi < lines.length && lines[qi].trim() === '') qi++;
    const question = qi < lines.length ? lines[qi].trim() : '';
    return { sourceUrl, context, pairs: question ? [{ question, answer: '' }] : [] };
  }

  const pairs = [];
  let current = null;
  const qRe = /^\s*\*\*(.+?)\*\*:?\s*(.*)$/;
  const urlRe = /^https?:\/\/\S+$/;
  for (; i < lines.length; i++) {
    const m = lines[i].match(qRe);
    if (m) {
      if (current) pairs.push(current);
      current = { question: m[1].trim(), answer: m[2] ? m[2].trim() : '' };
    } else if (current) {
      // TRW's prompts often embed a reference link on its own line right
      // under the question heading, not at the very top of the paste —
      // pull the first one out to the shared source link instead of
      // leaving it stuck as the first line of the answer.
      if (!current.answer && !sourceUrl && urlRe.test(lines[i].trim())) { sourceUrl = lines[i].trim(); continue; }
      current.answer += (current.answer ? '\n' : '') + lines[i];
    }
  }
  if (current) pairs.push(current);
  pairs.forEach(p => { p.answer = p.answer.replace(/^\n+|\n+$/g, ''); });

  const bulletRe = /^\s*[-*]\s+(.+)$/;
  const bulletQuestions = []; // exploded questions from any all-bullet pair
  const headingPairs = []; // pairs whose answer was prose, not bullets
  for (const p of pairs) {
    const answerLines = p.answer.split('\n').filter(l => l.trim() !== '');
    const allBullets = answerLines.length > 0 && answerLines.every(l => bulletRe.test(l));
    if (allBullets) answerLines.forEach(l => bulletQuestions.push({ question: l.match(bulletRe)[1].trim(), answer: '' }));
    else headingPairs.push(p);
  }
  // A bullet-exploded pair proves this was a fresh unanswered paste (shape 2)
  // — the heading pairs before it are scenario context, not real questions.
  // With no bullet explosion, every pair is a real answered question (shape
  // 1) and stays as-is; none of it becomes context.
  if (bulletQuestions.length) {
    const context = headingPairs.map(p => `**${p.question}**${p.answer ? '\n\n' + p.answer : ''}`).join('\n\n');
    return { sourceUrl, context, pairs: bulletQuestions };
  }
  return { sourceUrl, context: '', pairs: headingPairs };
}

function formatQABlock(sourceUrl, pairs) {
  let out = sourceUrl ? sourceUrl + '\n\n' : '';
  out += pairs.map(p => `**${p.question}**\n\n${p.answer || ''}`).join('\n\n');
  return out;
}

async function loadDailyTasks() {
  try { dailyTasks = await apiCall('GET', '/daily-tasks'); } catch (e) { toast('Could not load daily tasks'); return; }
  renderDailyTaskCatBar();
  renderDailyTasksList();
}

function renderDailyTaskCatBar() {
  const bar = document.getElementById('daily-task-cat-bar');
  if (!bar) return;
  if (!dailyTasks.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = Object.entries(DAILY_TASK_CAT_LABELS).map(([cat, label]) => {
    const active = cat === currentDailyTaskCategory;
    const c = tagColor(label);
    return `<span class="tag-filter-pill${active ? ' active' : ''}" data-cat="${cat}" style="--tag-c:${c}"><span class="tag-color-dot" data-label="${escHtml(label)}" style="background:${c}" title="Change color"></span>${escHtml(label)}</span>`;
  }).join('') + (currentDailyTaskCategory ? `<span class="tag-filter-clear" id="daily-task-cat-clear">✕</span>` : '');
  bar.querySelectorAll('.tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      currentDailyTaskCategory = el.dataset.cat === currentDailyTaskCategory ? null : el.dataset.cat;
      renderDailyTaskCatBar(); renderDailyTasksList();
    });
  });
  bar.querySelectorAll('.tag-color-dot').forEach(dot => {
    dot.addEventListener('click', e => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = tagColor(dot.dataset.label);
      inp.addEventListener('input', () => setTagColor(dot.dataset.label, inp.value));
      inp.click();
    });
  });
  document.getElementById('daily-task-cat-clear')?.addEventListener('click', () => {
    currentDailyTaskCategory = null; renderDailyTaskCatBar(); renderDailyTasksList();
  });
}

function renderDailyTasksList() {
  const list = document.getElementById('daily-tasks-list');
  if (!list) return;
  const filtered = currentDailyTaskCategory ? dailyTasks.filter(t => t.category === currentDailyTaskCategory) : dailyTasks;
  list.innerHTML = filtered.map(t => `
    <div class="note-item${t.id === currentDailyTaskId ? ' active' : ''}" data-id="${t.id}">
      <div class="note-item-title">${escHtml(isoToMdy(t.task_date))}</div>
      <div class="note-item-snippet">${escHtml((t.questions[0]?.question || '').slice(0, 60))}</div>
      <div class="note-item-tags"><span class="note-tag" style="--tag-c:${tagColor(DAILY_TASK_CAT_LABELS[t.category])}">${escHtml(DAILY_TASK_CAT_LABELS[t.category])}</span></div>
    </div>`).join('') || '<div style="padding:16px 12px;color:#444;font-size:12px;">No daily tasks yet</div>';
  list.querySelectorAll('.note-item').forEach(el => el.addEventListener('click', () => openDailyTask(el.dataset.id)));
}

function openDailyTask(id) {
  const t = dailyTasks.find(x => x.id === id);
  if (!t) return;
  currentDailyTaskId = id;
  dailyTaskDraft = { category: t.category, task_date: t.task_date, source_url: t.source_url, context: t.context || '', questions: t.questions.map(q => ({ ...q })) };
  renderDailyTasksList();
  renderDailyTaskForm();
  if (isMobile()) closeSidebar();
}

function newDailyTaskPaste() {
  currentDailyTaskId = null;
  dailyTaskDraft = null;
  renderDailyTasksList();
  const area = document.getElementById('daily-task-editor-area');
  area.innerHTML = `
    <div class="daily-task-paste-wrap">
      <div class="expense-field-row">
        <label>Category</label>
        <select id="dt-paste-category">
          <option value="business_masters">Business Master</option>
          <option value="daily_marketing">Daily Marketing</option>
          <option value="daily_seo_task">Daily SEO Task</option>
        </select>
      </div>
      <div class="expense-field-row">
        <label>Date</label>
        <input type="date" id="dt-paste-date">
      </div>
      <div class="expense-field-row">
        <label>Link</label>
        <input type="url" id="dt-paste-link" placeholder="Message link (https://app.jointherealworld.com/chat/...)">
      </div>
      <textarea id="dt-paste-raw" class="daily-task-paste-box" placeholder="Paste the prompt here — **bolded questions**, or a plain QUESTION: line…"></textarea>
      <button class="save-btn" id="dt-parse-btn">Parse into a form</button>
    </div>`;
  document.getElementById('dt-paste-date').value = dpToIso(new Date());
  document.getElementById('dt-parse-btn').addEventListener('click', () => {
    const raw = document.getElementById('dt-paste-raw').value;
    const { sourceUrl, context, pairs } = parseQABlock(raw);
    if (!pairs.length) { toast('Could not find any questions in that text'); return; }
    const manualLink = document.getElementById('dt-paste-link').value.trim();
    dailyTaskDraft = {
      category: document.getElementById('dt-paste-category').value,
      task_date: document.getElementById('dt-paste-date').value,
      source_url: manualLink || sourceUrl,
      context,
      questions: pairs,
    };
    renderDailyTaskForm();
  });
}

function renderDailyTaskForm() {
  const area = document.getElementById('daily-task-editor-area');
  const d = dailyTaskDraft;
  const isEdit = !!currentDailyTaskId;
  area.innerHTML = `
    <div class="daily-task-form">
      <div class="daily-task-form-head">
        <select id="dt-category">
          <option value="business_masters"${d.category === 'business_masters' ? ' selected' : ''}>Business Master</option>
          <option value="daily_marketing"${d.category === 'daily_marketing' ? ' selected' : ''}>Daily Marketing</option>
          <option value="daily_seo_task"${d.category === 'daily_seo_task' ? ' selected' : ''}>Daily SEO Task</option>
        </select>
        <input type="date" id="dt-date" value="${escHtml(d.task_date)}">
        <input type="url" id="dt-source-url" class="daily-task-source-input" placeholder="Message link (https://app.jointherealworld.com/chat/...)" value="${escHtml(d.source_url || '')}">
        ${d.source_url ? `<a href="${escHtml(d.source_url)}" target="_blank" rel="noopener" class="daily-task-source-link">Open ↗</a>` : ''}
      </div>
      ${d.context ? `
      <div class="daily-task-context">
        <div class="daily-task-context-label">Context</div>
        <textarea id="dt-context">${escHtml(d.context)}</textarea>
      </div>` : ''}
      ${d.questions.map((q, i) => `
        <div class="daily-task-qa">
          <div class="daily-task-question-row">
            <div class="daily-task-question">${escHtml(q.question)}</div>
            <button class="daily-task-remove-q" data-i="${i}" title="Remove this question">✕</button>
          </div>
          <textarea class="daily-task-answer" data-i="${i}" placeholder="Your answer…">${escHtml(q.answer)}</textarea>
        </div>`).join('')}
      <div class="daily-task-form-actions">
        ${isEdit ? '<button class="del-task-btn" id="dt-delete-btn">Delete</button>' : '<span></span>'}
        <div style="display:flex;gap:8px;">
          <button class="cancel-sel-btn" id="dt-copy-btn">Copy formatted</button>
          <button class="save-btn" id="dt-save-btn">Save</button>
        </div>
      </div>
    </div>`;
  area.querySelectorAll('.daily-task-answer').forEach(ta => {
    ta.addEventListener('input', () => { d.questions[+ta.dataset.i].answer = ta.value; });
  });
  area.querySelectorAll('.daily-task-remove-q').forEach(btn => {
    btn.addEventListener('click', () => { d.questions.splice(+btn.dataset.i, 1); renderDailyTaskForm(); });
  });
  document.getElementById('dt-category').addEventListener('change', e => { d.category = e.target.value; });
  document.getElementById('dt-date').addEventListener('change', e => { d.task_date = e.target.value; });
  document.getElementById('dt-source-url').addEventListener('change', e => { d.source_url = e.target.value.trim(); renderDailyTaskForm(); });
  const dtContextEl = document.getElementById('dt-context');
  if (dtContextEl) {
    const growContext = () => { dtContextEl.style.height = 'auto'; dtContextEl.style.height = dtContextEl.scrollHeight + 'px'; };
    dtContextEl.addEventListener('input', e => { d.context = e.target.value; growContext(); });
    growContext();
  }
  document.getElementById('dt-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(formatQABlock(d.source_url, d.questions)).then(() => toast('Copied'));
  });
  document.getElementById('dt-save-btn').addEventListener('click', saveDailyTask);
  document.getElementById('dt-delete-btn')?.addEventListener('click', deleteCurrentDailyTask);
}

async function saveDailyTask() {
  const d = dailyTaskDraft;
  if (!d.task_date) { toast('Date required'); return; }
  const body = { category: d.category, task_date: d.task_date, source_url: d.source_url, context: d.context || '', questions: d.questions };
  try {
    if (currentDailyTaskId) {
      const updated = await apiCall('PUT', '/daily-tasks/' + currentDailyTaskId, body);
      const idx = dailyTasks.findIndex(t => t.id === updated.id);
      if (idx >= 0) dailyTasks[idx] = updated;
    } else {
      const created = await apiCall('POST', '/daily-tasks', body);
      dailyTasks.unshift(created);
      currentDailyTaskId = created.id;
      renderDailyTaskForm(); // switches from "fresh paste" to "saved entry" (adds Delete)
    }
    renderDailyTaskCatBar(); renderDailyTasksList();
    toast('Saved');
  } catch (e) {
    toast('Could not save: ' + (String(e.message || '').match(/"error":"([^"]+)"/)?.[1] || 'check connection'));
  }
}

async function deleteCurrentDailyTask() {
  if (!currentDailyTaskId) return;
  if (!confirm('Delete this daily task entry?')) return;
  const id = currentDailyTaskId;
  dailyTasks = dailyTasks.filter(t => t.id !== id);
  currentDailyTaskId = null; dailyTaskDraft = null;
  renderDailyTasksList();
  document.getElementById('daily-task-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">Select an entry, or hit + to paste a new one.</div>`;
  try { await apiCall('DELETE', '/daily-tasks/' + id); } catch(e) {}
}

// ── Follow-ups (8-touch warm-lead drip sequences) ────────────────
// Skeleton copy (type + body per touch) mirrors server.js's
// FOLLOWUP_TOUCH_PLAN — the server fills it in at creation, this file just
// renders/edits/saves whatever comes back as followup.data.touches.
let followups = [];
let currentFollowupId = null;
let followupDraft = null; // { lead_name, business_name, status, data: { touches: [...] } }

async function loadFollowups() {
  try { followups = await apiCall('GET', '/followups'); } catch (e) { toast('Could not load follow-ups'); return; }
  renderFollowupsList();
}

function renderFollowupsList() {
  const list = document.getElementById('followups-list');
  if (!list) return;
  const t = Date.now();
  list.innerHTML = followups.map(f => {
    const overdue = f.next_due_at && f.next_due_at < t;
    return `
    <div class="note-item${f.id === currentFollowupId ? ' active' : ''}" data-id="${f.id}">
      <div class="note-item-title">${escHtml(f.business_name || 'Untitled follow-up')}</div>
      <div class="note-item-snippet">${escHtml(f.lead_name || '')}</div>
      <div class="note-item-tags">
        ${f.next_label ? `<span class="note-tag"${overdue ? ' style="--tag-c:#c0392b"' : ''}>${overdue ? 'Overdue: ' : 'Next: '}${escHtml(f.next_label)}</span>` : '<span class="note-tag" style="--tag-c:#2e7d32">All touches sent</span>'}
      </div>
    </div>`;
  }).join('') || '<div style="padding:16px 12px;color:#444;font-size:12px;">No follow-up sequences yet</div>';
  list.querySelectorAll('.note-item').forEach(el => el.addEventListener('click', () => openFollowup(el.dataset.id)));
}

async function openFollowup(id) {
  let f;
  try { f = await apiCall('GET', '/followups/' + id); } catch (e) { toast('Could not load'); return; }
  currentFollowupId = id;
  followupDraft = { lead_name: f.lead_name, business_name: f.business_name, status: f.status, data: f.data, lead_id: f.lead_id };
  renderFollowupsList();
  renderFollowupEditor();
  if (isMobile()) closeSidebar();
}

// (The old standalone new-follow-up form was deleted in rfy-crm — sequences
// are always created from inside a lead now via newFollowupForLead, and the
// server 400s a POST without a live lead_id.)

function renderFollowupEditor() {
  const area = document.getElementById('followup-editor-area');
  const d = followupDraft;
  // rfy-crm §1.9: business name locked to the parent lead, same as audits.
  const nameLocked = !!d.lead_id;
  area.innerHTML = `
    <div class="daily-task-form">
      <div class="daily-task-form-head">
        <input type="text" id="fu-lead-name" placeholder="Lead name" value="${escHtml(d.lead_name || '')}">
        <input type="text" id="fu-business-name" placeholder="Business" value="${escHtml(d.business_name || '')}"${nameLocked ? ' disabled title="Locked to the lead\'s business name"' : ''}>
        <select id="fu-status">
          <option value="active"${d.status === 'active' ? ' selected' : ''}>Active</option>
          <option value="paused"${d.status === 'paused' ? ' selected' : ''}>Paused</option>
          <option value="won"${d.status === 'won' ? ' selected' : ''}>Won</option>
          <option value="dead"${d.status === 'dead' ? ' selected' : ''}>Dead</option>
        </select>
      </div>
      ${d.data.touches.map((t, i) => `
        <div class="daily-task-qa followup-touch${t.status === 'sent' ? ' followup-touch-sent' : ''}">
          <div class="daily-task-question-row">
            <div class="daily-task-question">Touch ${i + 1} · Day ${t.day} · ${escHtml(t.label)} · due ${fmtDate(t.due_at)}${t.status === 'sent' ? ' · sent ' + fmtDate(t.sent_at) : ''}</div>
            <button class="cancel-sel-btn followup-mark-btn" data-i="${i}">${t.status === 'sent' ? 'Mark unsent' : 'Mark sent'}</button>
          </div>
          <textarea class="daily-task-answer followup-body" data-i="${i}" placeholder="Body…">${escHtml(t.body)}</textarea>
        </div>`).join('')}
      <div class="daily-task-form-actions">
        <button class="del-task-btn" id="fu-delete-btn">Delete sequence</button>
        <button class="save-btn" id="fu-save-btn">Save</button>
      </div>
    </div>`;
  area.querySelectorAll('.followup-body').forEach(ta => {
    ta.addEventListener('input', () => { d.data.touches[+ta.dataset.i].body = ta.value; });
  });
  area.querySelectorAll('.followup-mark-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = d.data.touches[+btn.dataset.i];
      if (t.status === 'sent') { t.status = 'pending'; t.sent_at = null; }
      else { t.status = 'sent'; t.sent_at = Date.now(); }
      renderFollowupEditor();
    });
  });
  document.getElementById('fu-lead-name').addEventListener('change', e => { d.lead_name = e.target.value.trim(); });
  document.getElementById('fu-business-name').addEventListener('change', e => { d.business_name = e.target.value.trim(); });
  document.getElementById('fu-status').addEventListener('change', e => { d.status = e.target.value; });
  document.getElementById('fu-save-btn').addEventListener('click', saveFollowup);
  document.getElementById('fu-delete-btn').addEventListener('click', deleteCurrentFollowup);
}

async function saveFollowup() {
  if (!currentFollowupId) return;
  const d = followupDraft;
  try {
    const updated = await apiCall('PUT', '/followups/' + currentFollowupId, { lead_name: d.lead_name, business_name: d.business_name, status: d.status, data: d.data });
    const next = updated.data.touches.find(t => t.status === 'pending');
    const idx = followups.findIndex(f => f.id === updated.id);
    const row = { id: updated.id, lead_name: updated.lead_name, business_name: updated.business_name, status: updated.status, updated_at: updated.updated_at, next_due_at: next ? next.due_at : null, next_label: next ? next.label : null };
    if (idx >= 0) followups[idx] = row; else followups.unshift(row);
    renderFollowupsList();
    const lf = currentLead?.followups?.find(f => f.id === updated.id);
    if (lf) Object.assign(lf, { status: row.status, updated_at: row.updated_at, next_due_at: row.next_due_at, next_label: row.next_label });
    toast('Saved');
  } catch (e) {
    toast('Could not save: ' + (String(e.message || '').match(/"error":"([^"]+)"/)?.[1] || 'check connection'));
  }
}

async function deleteCurrentFollowup() {
  if (!currentFollowupId) return;
  if (!confirm('Delete this follow-up sequence?')) return;
  const id = currentFollowupId;
  followups = followups.filter(f => f.id !== id);
  currentFollowupId = null; followupDraft = null;
  renderFollowupsList();
  document.getElementById('followup-editor-area').innerHTML = `<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">Select a follow-up sequence, or hit + to start one for a lead.</div>`;
  try { await apiCall('DELETE', '/followups/' + id); } catch(e) {}
}

// ── Tourist (unit converter, migrated from tourist.rfisolns.org) ──
// Self-contained: own IIFE so its generic helper names (clamp, r1, r2...)
// never touch the rest of the app. Markup lives in #tourist-view; this runs
// once at load same as the rest of the app's event wiring.
(function () {
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r0(n) { return Math.round(n); }

  const NUM_INPUT_IDS = ['f-input','c-input','ft-input','in-input','cm-input',
    'mi-input','km-input','lb-input','kg-input','usd-input','fx-input',
    'sqft-input','sqm-input'];
  function autoFit(input) {
    if (!input) return;
    const len = (input.value || '').length || 1;
    const w = input.clientWidth || 76;
    const base = window.matchMedia('(max-width: 640px)').matches ? 17 : 20;
    input.style.fontSize = clamp(Math.floor((w - 6) / (len * 0.6)), 10, base) + 'px';
  }
  function fitAll() { NUM_INPUT_IDS.forEach(id => autoFit(document.getElementById(id))); }
  document.addEventListener('input', fitAll);
  window.addEventListener('resize', fitAll);

  (function () {
    const ORDER_KEY = 'tourist-order';
    const mainEl = document.querySelector('.tourist-main');
    if (!mainEl) return;

    let order;
    try { order = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch (e) { order = null; }
    if (Array.isArray(order)) {
      order.forEach(id => { const el = document.getElementById(id); if (el) mainEl.appendChild(el); });
    }

    function saveOrder() {
      localStorage.setItem(ORDER_KEY,
        JSON.stringify([...mainEl.querySelectorAll('.converter')].map(el => el.id)));
    }

    let dragEl = null;
    mainEl.querySelectorAll('.conv-label').forEach(label => {
      label.addEventListener('dragstart', e => {
        dragEl = label.closest('.converter');
        dragEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragEl.id);
      });
      label.addEventListener('dragend', () => {
        if (dragEl) dragEl.classList.remove('dragging');
        dragEl = null;
        saveOrder();
      });
    });
    mainEl.addEventListener('dragover', e => {
      if (!dragEl) return;
      e.preventDefault();
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.converter');
      if (!target || target === dragEl) return;
      const r = target.getBoundingClientRect();
      const before = (e.clientX - r.left) < r.width / 2;
      mainEl.insertBefore(dragEl, before ? target : target.nextSibling);
    });
  })();

  class VSlider {
    constructor(trackEl, thumbEl, min, max, initVal, onChange, opts) {
      this.track   = trackEl;
      this.thumb   = thumbEl;
      this.min     = min;
      this.max     = max;
      this.val     = initVal;
      this.onChange = onChange;
      this.log     = !!(opts && opts.log);
      this._dragging = false;
      this._bind();
      this._render();
    }

    setValue(v) {
      this.val = clamp(v, this.min, this.max);
      this._render();
    }

    _pct(v) {
      if (this.log) {
        const lo = Math.log(this.min), hi = Math.log(this.max);
        return (Math.log(clamp(v, this.min, this.max)) - lo) / (hi - lo);
      }
      return (v - this.min) / (this.max - this.min);
    }
    _size()    { return this.track.offsetHeight; }
    _vToPos(v) { return (1 - this._pct(v)) * this._size(); }
    _posToV(p) {
      const f = clamp(1 - p / this._size(), 0, 1);
      if (this.log) {
        const lo = Math.log(this.min), hi = Math.log(this.max);
        return Math.exp(lo + f * (hi - lo));
      }
      return this.min + f * (this.max - this.min);
    }

    _render() {
      this.thumb.style.top  = this._vToPos(this.val) + 'px';
      this.thumb.style.left = '50%';
    }

    _relY(e) {
      const r = this.track.getBoundingClientRect();
      return (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    }

    _bind() {
      const start = (e) => {
        this._dragging = true;
        this.thumb.classList.add('dragging');
        this.val = this._posToV(this._relY(e));
        this._render();
        this.onChange(this.val);
        e.preventDefault();
      };
      const move = (e) => {
        if (!this._dragging) return;
        this.val = this._posToV(this._relY(e));
        this._render();
        this.onChange(this.val);
        e.preventDefault();
      };
      const end = () => {
        this._dragging = false;
        this.thumb.classList.remove('dragging');
      };
      this.track.addEventListener('mousedown',  start);
      document.addEventListener('mousemove',    move);
      document.addEventListener('mouseup',      end);
      this.track.addEventListener('touchstart', start, { passive: false });
      document.addEventListener('touchmove',    move,  { passive: false });
      document.addEventListener('touchend',     end);
    }
  }

  function buildMarkers(container, refs, min, max, side, log) {
    if (!container) return;
    container.innerHTML = '';
    const total = max - min;
    const lo = Math.log(min), hi = Math.log(max);
    refs.forEach(ref => {
      const el = document.createElement('div');
      el.className = 'marker';
      el.dataset.v = ref.v;
      const pct = log ? (Math.log(ref.v) - lo) / (hi - lo) : (ref.v - min) / total;
      el.style.top = ((1 - pct) * 100) + '%';
      const tick = '<div class="marker-tick"></div>';
      const text = `<div class="marker-text">${ref.label.replace('\n','<br>')}</div>`;
      el.innerHTML = side === 'left' ? text + tick : tick + text;
      container.appendChild(el);
    });
  }

  function highlightMarkers(leftContainer, rightContainer, val, rightRefs, threshold) {
    [leftContainer, rightContainer].forEach(c =>
      c.querySelectorAll('.marker').forEach(el =>
        el.classList.toggle('active', Math.abs(parseFloat(el.dataset.v) - val) < threshold)
      )
    );
    const m = rightRefs.find(r => Math.abs(r.v - val) < threshold);
    return m ? (m.note || '') : '';
  }

  const touristView = document.getElementById('tourist-view');
  if (!touristView) return;

  // TEMPERATURE
  const TEMP_MIN = -40, TEMP_MAX = 120;
  const tempLeftRefs = [
    { v: 120,  label: '48.9°C' }, { v: 98.6, label: '37°C' }, { v: 72, label: '22°C' },
    { v: 32,   label: '0°C'    }, { v: -40,  label: '−40°C' },
  ];
  const tempRightRefs = [
    { v: 120,  label: '120°F',  note: 'Upper range' },
    { v: 98.6, label: '98.6°F', note: 'Normal body temperature' },
    { v: 72,   label: '72°F',   note: 'Room temperature' },
    { v: 32,   label: '32°F',   note: 'Freezing point of water' },
    { v: -40,  label: '−40°F',  note: '−40° same in both scales' },
  ];
  const tempMarkersLeft  = document.getElementById('temp-markers-left');
  const tempMarkersRight = document.getElementById('temp-markers-right');
  const tempNote         = document.getElementById('temp-note');
  const fInput = document.getElementById('f-input'), cInput = document.getElementById('c-input');
  buildMarkers(tempMarkersLeft,  tempLeftRefs,  TEMP_MIN, TEMP_MAX, 'left');
  buildMarkers(tempMarkersRight, tempRightRefs, TEMP_MIN, TEMP_MAX, 'right');
  function fToC(f) { return (f - 32) * 5 / 9; }
  function cToF(c) { return c * 9 / 5 + 32; }
  let tempVal = 72;
  const tempSlider = new VSlider(document.getElementById('temp-track'), document.getElementById('temp-thumb'),
    TEMP_MIN, TEMP_MAX, tempVal, v => { tempVal = v; renderTemp(); });
  function renderTemp() {
    fInput.value = r1(tempVal); cInput.value = r1(fToC(tempVal)); tempSlider.setValue(tempVal);
    tempNote.textContent = highlightMarkers(tempMarkersLeft, tempMarkersRight, tempVal, tempRightRefs, 3);
  }
  fInput.addEventListener('input', () => {
    if (fInput.value === '') return;
    tempVal = parseFloat(fInput.value);
    cInput.value = r1(fToC(tempVal)); tempSlider.setValue(tempVal);
    tempNote.textContent = highlightMarkers(tempMarkersLeft, tempMarkersRight, tempVal, tempRightRefs, 3);
  });
  cInput.addEventListener('input', () => {
    if (cInput.value === '') return;
    tempVal = cToF(parseFloat(cInput.value));
    fInput.value = r1(tempVal); tempSlider.setValue(tempVal);
    tempNote.textContent = highlightMarkers(tempMarkersLeft, tempMarkersRight, tempVal, tempRightRefs, 3);
  });
  renderTemp();

  // HEIGHT (slider unit: total inches)
  const H_MIN = 48, H_MAX = 84;
  const heightLeftRefs = [
    { v: 84, label: '213 cm' }, { v: 72, label: '183 cm' }, { v: 67, label: '170 cm' },
    { v: 60, label: '152 cm' }, { v: 48, label: '122 cm' },
  ];
  const heightRightRefs = [
    { v: 84, label: "7'0\"", note: '7 feet' }, { v: 72, label: "6'0\"", note: '6 feet' },
    { v: 67, label: "5'7\"", note: 'Global avg. height' }, { v: 60, label: "5'0\"", note: '5 feet' },
    { v: 48, label: "4'0\"", note: '4 feet' },
  ];
  const heightMarkersLeft  = document.getElementById('height-markers-left');
  const heightMarkersRight = document.getElementById('height-markers-right');
  const heightNote = document.getElementById('height-note');
  const ftInput = document.getElementById('ft-input'), inInput = document.getElementById('in-input'), cmInput = document.getElementById('cm-input');
  buildMarkers(heightMarkersLeft,  heightLeftRefs,  H_MIN, H_MAX, 'left');
  buildMarkers(heightMarkersRight, heightRightRefs, H_MIN, H_MAX, 'right');
  function inchesToCm(i) { return i * 2.54; }
  function cmToInches(c) { return c / 2.54; }
  let heightVal = 67;
  const heightSlider = new VSlider(document.getElementById('height-track'), document.getElementById('height-thumb'),
    H_MIN, H_MAX, heightVal, v => { heightVal = v; renderHeight(); });
  function renderHeight() {
    const ft = Math.floor(heightVal / 12);
    const inches = Math.round(heightVal % 12);
    ftInput.value  = inches === 12 ? ft + 1 : ft;
    inInput.value  = inches === 12 ? 0 : inches;
    cmInput.value  = r0(inchesToCm(heightVal));
    heightSlider.setValue(heightVal);
    heightNote.textContent = highlightMarkers(heightMarkersLeft, heightMarkersRight, heightVal, heightRightRefs, 1.5);
  }
  function normalizeAndSetHeight() {
    let ft  = parseInt(ftInput.value) || 0;
    let ins = parseInt(inInput.value) || 0;
    if (ins >= 12) { ft += Math.floor(ins / 12); ins = ins % 12; }
    if (ins < 0)   { ft += Math.floor(ins / 12); ins = ((ins % 12) + 12) % 12; }
    heightVal = ft * 12 + ins;
    ftInput.value = Math.floor(heightVal / 12);
    inInput.value = Math.round(heightVal % 12);
    cmInput.value = r0(inchesToCm(heightVal));
    heightSlider.setValue(heightVal);
    heightNote.textContent = highlightMarkers(heightMarkersLeft, heightMarkersRight, heightVal, heightRightRefs, 1.5);
  }
  ftInput.addEventListener('input', normalizeAndSetHeight);
  inInput.addEventListener('input', () => {
    const ft  = parseInt(ftInput.value) || 0;
    let ins   = parseInt(inInput.value);
    if (isNaN(ins)) return;
    if (ins >= 12) { normalizeAndSetHeight(); return; }
    heightVal = ft * 12 + ins;
    cmInput.value = r0(inchesToCm(heightVal));
    heightSlider.setValue(heightVal);
    heightNote.textContent = highlightMarkers(heightMarkersLeft, heightMarkersRight, heightVal, heightRightRefs, 1.5);
  });
  inInput.addEventListener('blur', normalizeAndSetHeight);
  ftInput.addEventListener('blur', normalizeAndSetHeight);
  cmInput.addEventListener('input', () => {
    if (cmInput.value === '') return;
    heightVal = cmToInches(parseFloat(cmInput.value));
    ftInput.value = Math.floor(heightVal / 12);
    inInput.value = Math.round(heightVal % 12);
    heightSlider.setValue(heightVal);
    heightNote.textContent = highlightMarkers(heightMarkersLeft, heightMarkersRight, heightVal, heightRightRefs, 1.5);
  });
  renderHeight();

  // DISTANCE (slider unit: miles)
  const D_MIN = 0, D_MAX = 100;
  const distLeftRefs = [
    { v: 100, label: '161 km' }, { v: 50, label: '80 km' }, { v: 26.2, label: '42 km' }, { v: 10, label: '16 km' },
  ];
  const distRightRefs = [
    { v: 100, label: '100 mi', note: '100 miles' }, { v: 50, label: '50 mi', note: '50 miles' },
    { v: 26.2, label: '26.2 mi', note: 'Marathon distance' }, { v: 10, label: '10 mi', note: '10 miles' },
  ];
  const distMarkersLeft  = document.getElementById('dist-markers-left');
  const distMarkersRight = document.getElementById('dist-markers-right');
  const distNote = document.getElementById('dist-note');
  const miInput = document.getElementById('mi-input'), kmInput = document.getElementById('km-input');
  buildMarkers(distMarkersLeft,  distLeftRefs,  D_MIN, D_MAX, 'left');
  buildMarkers(distMarkersRight, distRightRefs, D_MIN, D_MAX, 'right');
  function miToKm(m) { return m * 1.60934; }
  function kmToMi(k) { return k / 1.60934; }
  let distVal = 5;
  const distSlider = new VSlider(document.getElementById('dist-track'), document.getElementById('dist-thumb'),
    D_MIN, D_MAX, distVal, v => { distVal = v; renderDist(); });
  function renderDist() {
    miInput.value = r1(distVal); kmInput.value = r1(miToKm(distVal)); distSlider.setValue(distVal);
    distNote.textContent = highlightMarkers(distMarkersLeft, distMarkersRight, distVal, distRightRefs, 2);
  }
  miInput.addEventListener('input', () => {
    if (miInput.value === '') return;
    distVal = parseFloat(miInput.value);
    kmInput.value = r1(miToKm(distVal)); distSlider.setValue(distVal);
    distNote.textContent = highlightMarkers(distMarkersLeft, distMarkersRight, distVal, distRightRefs, 2);
  });
  kmInput.addEventListener('input', () => {
    if (kmInput.value === '') return;
    distVal = kmToMi(parseFloat(kmInput.value));
    miInput.value = r1(distVal); distSlider.setValue(distVal);
    distNote.textContent = highlightMarkers(distMarkersLeft, distMarkersRight, distVal, distRightRefs, 2);
  });
  renderDist();

  // WEIGHT (slider unit: pounds)
  const W_MIN = 0, W_MAX = 300;
  const weightLeftRefs = [
    { v: 300, label: '136 kg' }, { v: 220, label: '100 kg' }, { v: 165, label: '75 kg' },
    { v: 110, label: '50 kg' }, { v: 0, label: '0 kg' },
  ];
  const weightRightRefs = [
    { v: 300, label: '300 lb', note: '300 pounds' }, { v: 220, label: '220 lb', note: '220 pounds' },
    { v: 165, label: '165 lb', note: 'Global avg. adult weight' }, { v: 110, label: '110 lb', note: '110 pounds' },
    { v: 0, label: '0 lb', note: '' },
  ];
  const weightMarkersLeft  = document.getElementById('weight-markers-left');
  const weightMarkersRight = document.getElementById('weight-markers-right');
  const weightNote = document.getElementById('weight-note');
  const lbInput = document.getElementById('lb-input'), kgInput = document.getElementById('kg-input');
  buildMarkers(weightMarkersLeft,  weightLeftRefs,  W_MIN, W_MAX, 'left');
  buildMarkers(weightMarkersRight, weightRightRefs, W_MIN, W_MAX, 'right');
  function lbToKg(l) { return l * 0.453592; }
  function kgToLb(k) { return k / 0.453592; }
  let weightVal = 165;
  const weightSlider = new VSlider(document.getElementById('weight-track'), document.getElementById('weight-thumb'),
    W_MIN, W_MAX, weightVal, v => { weightVal = v; renderWeight(); });
  function renderWeight() {
    lbInput.value = r1(weightVal); kgInput.value = r1(lbToKg(weightVal)); weightSlider.setValue(weightVal);
    weightNote.textContent = highlightMarkers(weightMarkersLeft, weightMarkersRight, weightVal, weightRightRefs, 3);
  }
  lbInput.addEventListener('input', () => {
    if (lbInput.value === '') return;
    weightVal = parseFloat(lbInput.value);
    kgInput.value = r1(lbToKg(weightVal)); weightSlider.setValue(weightVal);
    weightNote.textContent = highlightMarkers(weightMarkersLeft, weightMarkersRight, weightVal, weightRightRefs, 3);
  });
  kgInput.addEventListener('input', () => {
    if (kgInput.value === '') return;
    weightVal = kgToLb(parseFloat(kgInput.value));
    lbInput.value = r1(weightVal); weightSlider.setValue(weightVal);
    weightNote.textContent = highlightMarkers(weightMarkersLeft, weightMarkersRight, weightVal, weightRightRefs, 3);
  });
  renderWeight();

  // CURRENCY (slider unit: US dollars · live exchange rates)
  const C_MIN = 1, C_MAX = 500;
  const CUR_MARKS = [1, 5, 20, 100, 500];
  const FX_FALLBACK = {
    USD:1, EUR:0.92, GBP:0.79, JPY:157, CNY:7.2, MXN:17, CAD:1.37, AUD:1.52,
    CHF:0.89, INR:83, THB:36, KRW:1370, BRL:5.4, ZAR:18.5, TRY:32, AED:3.67,
    SGD:1.35, HKD:7.8, NZD:1.64, SEK:10.5, NOK:10.7, DKK:6.9, PLN:4.0, CZK:23,
    VND:25400, IDR:16200, PHP:58, MYR:4.7, EGP:48, ARS:900, ILS:3.7, CLP:940,
    COP:4000, ISK:138, HUF:360,
    AMD:387, GEL:2.7, AZN:1.7, RUB:88, UAH:41, KZT:480, RSD:108, RON:4.6,
    BGN:1.8, HRK:6.9, MAD:9.9, TND:3.1, JOD:0.71, SAR:3.75, QAR:3.64, KWD:0.31,
    LKR:300, NPR:133, PKR:278, BDT:118, TWD:32, MOP:8,
  };
  const CURRENCY_NAMES = {
    USD:'US Dollar', EUR:'Euro', GBP:'British Pound', JPY:'Japanese Yen',
    CNY:'Chinese Yuan', AUD:'Australian Dollar', CAD:'Canadian Dollar',
    CHF:'Swiss Franc', HKD:'Hong Kong Dollar', SGD:'Singapore Dollar',
    NZD:'New Zealand Dollar', SEK:'Swedish Krona', NOK:'Norwegian Krone',
    DKK:'Danish Krone', INR:'Indian Rupee', MXN:'Mexican Peso', BRL:'Brazilian Real',
    ZAR:'South African Rand', RUB:'Russian Ruble', TRY:'Turkish Lira',
    KRW:'South Korean Won', THB:'Thai Baht', IDR:'Indonesian Rupiah',
    MYR:'Malaysian Ringgit', PHP:'Philippine Peso', VND:'Vietnamese Dong',
    PLN:'Polish Zloty', CZK:'Czech Koruna', HUF:'Hungarian Forint',
    ILS:'Israeli Shekel', AED:'UAE Dirham', SAR:'Saudi Riyal', QAR:'Qatari Riyal',
    KWD:'Kuwaiti Dinar', BHD:'Bahraini Dinar', OMR:'Omani Rial', JOD:'Jordanian Dinar',
    EGP:'Egyptian Pound', MAD:'Moroccan Dirham', TND:'Tunisian Dinar',
    DZD:'Algerian Dinar', NGN:'Nigerian Naira', KES:'Kenyan Shilling',
    GHS:'Ghanaian Cedi', UGX:'Ugandan Shilling', TZS:'Tanzanian Shilling',
    ETB:'Ethiopian Birr', XOF:'West African CFA Franc', XAF:'Central African CFA Franc',
    ARS:'Argentine Peso', CLP:'Chilean Peso', COP:'Colombian Peso', PEN:'Peruvian Sol',
    UYU:'Uruguayan Peso', BOB:'Bolivian Boliviano', PYG:'Paraguayan Guarani',
    VES:'Venezuelan Bolivar', CRC:'Costa Rican Colon', GTQ:'Guatemalan Quetzal',
    DOP:'Dominican Peso', JMD:'Jamaican Dollar', TTD:'Trinidad & Tobago Dollar',
    BBD:'Barbadian Dollar', BSD:'Bahamian Dollar', BMD:'Bermudian Dollar',
    XCD:'East Caribbean Dollar', ISK:'Icelandic Krona', RON:'Romanian Leu',
    BGN:'Bulgarian Lev', HRK:'Croatian Kuna', RSD:'Serbian Dinar',
    UAH:'Ukrainian Hryvnia', GEL:'Georgian Lari', AMD:'Armenian Dram',
    AZN:'Azerbaijani Manat', KZT:'Kazakhstani Tenge', UZS:'Uzbekistani Som',
    KGS:'Kyrgystani Som', TJS:'Tajikistani Somoni', TMT:'Turkmenistani Manat',
    BYN:'Belarusian Ruble', MDL:'Moldovan Leu', ALL:'Albanian Lek',
    MKD:'Macedonian Denar', BAM:'Bosnia-Herzegovina Mark', TWD:'Taiwan Dollar',
    PKR:'Pakistani Rupee', BDT:'Bangladeshi Taka', LKR:'Sri Lankan Rupee',
    NPR:'Nepalese Rupee', MMK:'Myanmar Kyat', KHR:'Cambodian Riel',
    LAK:'Laotian Kip', MNT:'Mongolian Tugrik', BND:'Brunei Dollar',
    MOP:'Macanese Pataca', FJD:'Fijian Dollar', PGK:'Papua New Guinean Kina',
    IRR:'Iranian Rial', IQD:'Iraqi Dinar', LBP:'Lebanese Pound', SYP:'Syrian Pound',
    YER:'Yemeni Rial', AFN:'Afghan Afghani', LYD:'Libyan Dinar', SDG:'Sudanese Pound',
    AOA:'Angolan Kwanza', ZMW:'Zambian Kwacha', MWK:'Malawian Kwacha',
    MZN:'Mozambican Metical', BWP:'Botswanan Pula', NAD:'Namibian Dollar',
    MUR:'Mauritian Rupee', SCR:'Seychellois Rupee', MGA:'Malagasy Ariary',
    RWF:'Rwandan Franc', CDF:'Congolese Franc', GNF:'Guinean Franc',
    SLL:'Sierra Leonean Leone', GMD:'Gambian Dalasi', LRD:'Liberian Dollar',
    SOS:'Somali Shilling', DJF:'Djiboutian Franc', ERN:'Eritrean Nakfa',
    SSP:'South Sudanese Pound', BIF:'Burundian Franc', CVE:'Cape Verdean Escudo',
    KMF:'Comorian Franc', SZL:'Eswatini Lilangeni', LSL:'Lesotho Loti',
    HNL:'Honduran Lempira', NIO:'Nicaraguan Cordoba', PAB:'Panamanian Balboa',
    HTG:'Haitian Gourde', SRD:'Surinamese Dollar', GYD:'Guyanaese Dollar',
    BZD:'Belize Dollar', AWG:'Aruban Florin', ANG:'Netherlands Antillean Guilder',
    KYD:'Cayman Islands Dollar', BTN:'Bhutanese Ngultrum', MVR:'Maldivian Rufiyaa',
    WST:'Samoan Tala', TOP:'Tongan Paanga', VUV:'Vanuatu Vatu', SBD:'Solomon Islands Dollar',
    XPF:'CFP Franc', GIP:'Gibraltar Pound', FKP:'Falkland Islands Pound',
    SHP:'Saint Helena Pound', JEP:'Jersey Pound', GGP:'Guernsey Pound',
    IMP:'Isle of Man Pound', FOK:'Faroese Krona', KID:'Kiribati Dollar',
    TVD:'Tuvaluan Dollar', ZWL:'Zimbabwean Dollar',
  };
  const FX_CACHE_KEY = 'tourist-fx-cache';
  let fxRates = null, fxAsOf = '', fxStale = true;
  const usdInput = document.getElementById('usd-input'), fxInput = document.getElementById('fx-input');
  const curNote = document.getElementById('cur-note');
  const curMarkersLeft = document.getElementById('cur-markers-left'), curMarkersRight = document.getElementById('cur-markers-right');
  const curCombo = document.getElementById('cur-combo'), curSearch = document.getElementById('cur-search'), curList = document.getElementById('cur-list');
  let curCode = localStorage.getItem('tourist-fx-cur') || 'EUR';
  function curName(code) { return CURRENCY_NAMES[code] || code; }
  function curLabel(code) { return code + ' · ' + curName(code); }
  function currencyCodes() {
    const src = fxRates || FX_FALLBACK;
    return Object.keys(src).sort((a, b) => curName(a).localeCompare(curName(b)));
  }
  function renderComboList(query) {
    const q = (query || '').trim().toUpperCase();
    const codes = currencyCodes().filter(code => !q || code.includes(q) || curName(code).toUpperCase().includes(q));
    curList.innerHTML = '';
    if (!codes.length) {
      const e = document.createElement('div'); e.className = 'combo-empty'; e.textContent = 'No match'; curList.appendChild(e); return;
    }
    codes.slice(0, 80).forEach(code => {
      const it = document.createElement('div');
      it.className = 'combo-item' + (code === curCode ? ' sel' : '');
      it.innerHTML = '<span class="code">' + code + '</span>' + curName(code);
      it.addEventListener('pointerdown', (ev) => { ev.preventDefault(); selectCode(code); });
      curList.appendChild(it);
    });
  }
  function openCombo() { curCombo.classList.add('open'); curSearch.value = ''; curSearch.placeholder = 'Type to search…'; renderComboList(''); }
  function closeCombo() { curCombo.classList.remove('open'); curSearch.value = curLabel(curCode); }
  function selectCode(code) {
    curCode = code; localStorage.setItem('tourist-fx-cur', curCode);
    closeCombo(); curSearch.blur(); buildCurMarkers(); renderCur();
  }
  curSearch.addEventListener('focus', openCombo);
  curSearch.addEventListener('input', () => renderComboList(curSearch.value));
  curSearch.addEventListener('blur', () => setTimeout(closeCombo, 150));
  curSearch.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const first = curList.querySelector('.combo-item');
      if (first) { ev.preventDefault(); selectCode(first.querySelector('.code').textContent); }
    } else if (ev.key === 'Escape') { closeCombo(); curSearch.blur(); }
  });
  curSearch.value = curLabel(curCode);
  function r2(n) { return Math.round(n * 100) / 100; }
  function fxRate() { return fxRates ? fxRates[curCode] : null; }
  function fxDecimals(code) {
    try { return new Intl.NumberFormat('en-US', { style:'currency', currency:code }).resolvedOptions().maximumFractionDigits; }
    catch { return 2; }
  }
  function roundFx(amount, code) { const f = Math.pow(10, fxDecimals(code)); return Math.round(amount * f) / f; }
  function fmtFxMark(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 10000)   return Math.round(n / 1000) + 'k';
    if (n >= 1000)    return Math.round(n).toLocaleString('en-US');
    if (n >= 1)       return (Math.round(n * 10) / 10).toLocaleString('en-US');
    return String(Math.round(n * 100) / 100);
  }
  let usdVal = 20;
  const curSlider = new VSlider(document.getElementById('cur-track'), document.getElementById('cur-thumb'),
    C_MIN, C_MAX, usdVal, v => { usdVal = v; renderCur(); }, { log: true });
  function buildCurMarkers() {
    const rate = fxRate();
    const rightRefs = CUR_MARKS.map(v => ({ v, label: '$' + v }));
    const leftRefs  = CUR_MARKS.map(v => ({ v, label: rate ? fmtFxMark(v * rate) + '\n' + curCode : '—' }));
    buildMarkers(curMarkersLeft,  leftRefs,  C_MIN, C_MAX, 'left',  true);
    buildMarkers(curMarkersRight, rightRefs, C_MIN, C_MAX, 'right', true);
  }
  function highlightCurMarkers() {
    const lo = Math.log(C_MIN), hi = Math.log(C_MAX);
    const valPct = (Math.log(clamp(usdVal, C_MIN, C_MAX)) - lo) / (hi - lo);
    [curMarkersLeft, curMarkersRight].forEach(c =>
      c.querySelectorAll('.marker').forEach(el => {
        const mp = (Math.log(parseFloat(el.dataset.v)) - lo) / (hi - lo);
        el.classList.toggle('active', Math.abs(mp - valPct) < 0.03);
      })
    );
  }
  function fxNoteText() {
    const rate = fxRate();
    if (!rate) return 'Exchange rates unavailable — check connection';
    const shown = rate >= 100 ? Math.round(rate).toLocaleString('en-US') : (Math.round(rate * 100) / 100).toLocaleString('en-US');
    let s = '1 USD = ' + shown + ' ' + curCode;
    if (fxAsOf) s += ' · ' + fxAsOf;
    if (fxStale) s += ' · offline';
    return s;
  }
  function autoFitCur(input) {
    const len = (input.value || '').length || 1;
    const w = input.clientWidth || 76;
    const base = window.matchMedia('(max-width: 640px)').matches ? 17 : 20;
    let size = Math.floor((w - 6) / (len * 0.6));
    input.style.fontSize = clamp(size, 10, base) + 'px';
  }
  function renderCur() {
    const rate = fxRate();
    usdInput.value = r2(usdVal);
    fxInput.value  = rate ? roundFx(usdVal * rate, curCode) : '';
    curSlider.setValue(usdVal);
    autoFitCur(usdInput); autoFitCur(fxInput);
    highlightCurMarkers();
    curNote.textContent = fxNoteText();
  }
  window.addEventListener('resize', () => { autoFitCur(usdInput); autoFitCur(fxInput); });
  usdInput.addEventListener('input', () => {
    if (usdInput.value === '') return;
    usdVal = Math.max(0, parseFloat(usdInput.value) || 0);
    const rate = fxRate();
    if (rate) fxInput.value = roundFx(usdVal * rate, curCode);
    curSlider.setValue(usdVal);
    autoFitCur(usdInput); autoFitCur(fxInput);
    highlightCurMarkers();
    curNote.textContent = fxNoteText();
  });
  fxInput.addEventListener('input', () => {
    if (fxInput.value === '') return;
    const rate = fxRate();
    if (!rate) return;
    usdVal = Math.max(0, (parseFloat(fxInput.value) || 0) / rate);
    usdInput.value = r2(usdVal);
    curSlider.setValue(usdVal);
    autoFitCur(usdInput); autoFitCur(fxInput);
    highlightCurMarkers();
    curNote.textContent = fxNoteText();
  });
  function applyRates(rates, asOf, stale) {
    fxRates = rates; fxAsOf = asOf || ''; fxStale = !!stale;
    buildCurMarkers(); renderCur();
  }
  function fmtAsOf(utc) {
    try { return new Date(utc).toLocaleDateString('en-US', { month:'short', day:'numeric' }); }
    catch { return ''; }
  }
  async function fetchRates() {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const d = await r.json();
      if (d && d.result === 'success' && d.rates) {
        const asOf = fmtAsOf(d.time_last_update_utc);
        localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates: d.rates, asOf }));
        applyRates(d.rates, asOf, false);
        return;
      }
    } catch (e) {}
    try {
      const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
      const d = await r.json();
      if (d && d.usd) {
        const rates = {};
        for (const k in d.usd) rates[k.toUpperCase()] = d.usd[k];
        const asOf = d.date ? fmtAsOf(d.date) : '';
        localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates, asOf }));
        applyRates(rates, asOf, false);
      }
    } catch (e) {}
  }
  let _cached = null;
  try { _cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || 'null'); } catch (e) {}
  if (_cached && _cached.rates) applyRates(_cached.rates, _cached.asOf, true);
  else applyRates(FX_FALLBACK, '', true);
  fetchRates();

  // AREA (slider unit: square feet)
  const A_MIN = 0, A_MAX = 1000;
  const areaLeftRefs = [
    { v: 1000, label: '93 m²' }, { v: 750, label: '70 m²' }, { v: 500, label: '46 m²' },
    { v: 250, label: '23 m²' }, { v: 0, label: '0 m²' },
  ];
  const areaRightRefs = [
    { v: 1000, label: '1000 ft²', note: '1000 sq. ft.' }, { v: 750, label: '750 ft²', note: 'Avg. US 1-bed apartment' },
    { v: 500, label: '500 ft²', note: '500 sq. ft.' }, { v: 250, label: '250 ft²', note: 'Studio apartment' },
    { v: 0, label: '0 ft²', note: '' },
  ];
  const areaMarkersLeft  = document.getElementById('area-markers-left');
  const areaMarkersRight = document.getElementById('area-markers-right');
  const areaNote = document.getElementById('area-note');
  const sqftInput = document.getElementById('sqft-input'), sqmInput = document.getElementById('sqm-input');
  buildMarkers(areaMarkersLeft,  areaLeftRefs,  A_MIN, A_MAX, 'left');
  buildMarkers(areaMarkersRight, areaRightRefs, A_MIN, A_MAX, 'right');
  function sqftToSqm(f) { return f * 0.092903; }
  function sqmToSqft(m) { return m / 0.092903; }
  let areaVal = 500;
  const areaSlider = new VSlider(document.getElementById('area-track'), document.getElementById('area-thumb'),
    A_MIN, A_MAX, areaVal, v => { areaVal = v; renderArea(); });
  function renderArea() {
    sqftInput.value = r1(areaVal); sqmInput.value = r1(sqftToSqm(areaVal)); areaSlider.setValue(areaVal);
    areaNote.textContent = highlightMarkers(areaMarkersLeft, areaMarkersRight, areaVal, areaRightRefs, 10);
  }
  sqftInput.addEventListener('input', () => {
    if (sqftInput.value === '') return;
    areaVal = parseFloat(sqftInput.value);
    sqmInput.value = r1(sqftToSqm(areaVal)); areaSlider.setValue(areaVal);
    areaNote.textContent = highlightMarkers(areaMarkersLeft, areaMarkersRight, areaVal, areaRightRefs, 10);
  });
  sqmInput.addEventListener('input', () => {
    if (sqmInput.value === '') return;
    areaVal = sqmToSqft(parseFloat(sqmInput.value));
    sqftInput.value = r1(areaVal); areaSlider.setValue(areaVal);
    areaNote.textContent = highlightMarkers(areaMarkersLeft, areaMarkersRight, areaVal, areaRightRefs, 10);
  });
  renderArea();

  fitAll();
})();

// ── Init ───────────────────────────────────────────────────────
(async () => {
  // Register SW first and wait for it to be active before anything else
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    } catch(e) {}
  }

  idb = await openIDB();
  updateOnlineDot();
  const saved = sessionStorage.getItem('ws_auth');
  if (saved) {
    authHeader = saved;
    try {
      await apiFetch('GET','/auth/check');
      setUploadsCookie();
      mirrorAuthForSw();
      refreshPushSubscription();
      document.getElementById('login-overlay').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      if (isMobile()) document.getElementById('left-panel').classList.add('collapsed');
      await fullSync();
      initNavTabsBar();
      outbox = await idbGetAll('outbox');
      if(outbox.length) flushOutbox();
      startPolling();
      initDialer(); // v161: register for inbound calls on session restore too
    } catch(e) { showLogin(); }
  }
})();


// ── Connections: health + balance board for every API / MCP we depend on ──
// Server checks hourly (connections.js); the Mac posts Claude Code's MCP list
// hourly (scripts/connections-client.js). "Check now" forces a server pass.
let connectionsData = null;
async function loadConnections() {
  try { connectionsData = await apiCall('GET', '/connections'); }
  catch (e) { toast('Could not load connections'); return; }
  renderConnections();
}
async function checkConnectionsNow(btn) {
  btn.disabled = true; btn.textContent = 'Checking…';
  try { await apiCall('POST', '/connections/check'); await loadConnections(); toast('Connections checked'); }
  catch (e) { toast('Check failed'); }
  btn.disabled = false; btn.textContent = 'Check now';
}
function cxAgo(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
}
function cxPill(status) {
  const label = { up: 'Up', low: 'Low', down: 'Down', unset: 'No key', idle: 'Idle' }[status] || status;
  return `<span class="cx-pill cx-${status}">${label}</span>`;
}
function cxBalance(r) {
  if (r.balance === null || r.balance === undefined) return '<span class="cx-m">' + escHtml(r.detail || '') + '</span>';
  const cap = Math.max(r.alert_at ? r.alert_at * 5 : 50, r.balance, 1);
  const pct = Math.min(100, Math.round(r.balance / cap * 100));
  const cls = r.status === 'low' ? ' cx-bar-low' : '';
  return `<span class="cx-bar${cls}"><i style="width:${pct}%"></i></span>$${r.balance.toFixed(2)}`;
}
function renderConnections() {
  const area = document.getElementById('connections-area');
  if (!area) return;
  const d = connectionsData || { rows: [], now: Date.now() };
  const rows = d.rows;
  const n = s => rows.filter(r => r.status === s).length;
  const last = rows.length ? Math.max(...rows.map(r => r.checked_at)) : null;
  const groups = [
    ['balance', 'Paid APIs with a balance', ['Service', 'Status', 'Balance', 'Used by', 'Alert at']],
    ['plan', 'Services on a plan', ['Service', 'Status', 'Detail', 'Used by', '']],
    ['mcp', 'MCP servers (Claude Code)', ['Server', 'Status', 'Detail', 'Kind', 'Checked']],
  ];
  const row = (g, r) => {
    const cells = g === 'balance'
      ? [cxBalance(r), escHtml(r.used_by), r.alert_at !== null ? '$' + r.alert_at : '<span class="cx-m">none</span>']
      : g === 'plan'
      ? [escHtml(r.detail), escHtml(r.used_by), '']
      : [escHtml(r.detail), escHtml(r.kind || ''), `<span class="cx-m">${cxAgo(d.now - r.checked_at)}</span>`];
    return `<tr><td>${escHtml(r.name)}</td><td>${cxPill(r.status)}</td>${cells.map(c => '<td>' + c + '</td>').join('')}</tr>`;
  };
  area.innerHTML = `
    <div class="cx-top">
      <div><h2 class="cx-h1">Connections</h2>
      <div class="cx-m">Every API and MCP this Mac and the Workspace server talk to. Checked hourly.
      ${last ? 'Last check ' + cxAgo(d.now - last) + '.' : 'No check yet.'}</div></div>
      <button class="cx-btn" id="cx-check-btn">Check now</button>
    </div>
    <div class="cx-tiles">
      <div class="cx-tile cx-up"><div class="n">${n('up')}</div><div class="l">Up</div></div>
      <div class="cx-tile cx-low"><div class="n">${n('low')}</div><div class="l">Low balance</div></div>
      <div class="cx-tile cx-down"><div class="n">${n('down')}</div><div class="l">Down</div></div>
      <div class="cx-tile cx-unset"><div class="n">${n('unset')}</div><div class="l">No key</div></div>
    </div>
    ${groups.map(([g, title, cols]) => {
      const list = rows.filter(r => r.group === g);
      return `<h3 class="cx-h2">${title}</h3><div class="cx-tbl"><table>
        <tr>${cols.map(c => '<th>' + c + '</th>').join('')}</tr>
        ${list.length ? list.map(r => row(g, r)).join('') : '<tr><td colspan="5" class="cx-m">Nothing reported yet.</td></tr>'}
      </table></div>`;
    }).join('')}
    <div class="cx-foot">Low balance or Down creates a Workspace reminder once per day per service.
    Claude Code prints the same warning at session start.</div>`;
  document.getElementById('cx-check-btn').addEventListener('click', e => checkConnectionsNow(e.currentTarget));
}
