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

let reminders = [];
let currentReminderId = null;
const remWeekdaySel = new Set();
let calendarViewMode = localStorage.getItem('calendar-view-mode') === 'month' ? 'month' : 'agenda';
let calendarMonthVisible = localStorage.getItem('calendar-month-visible') !== '0';

let calls = [];
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
async function enqueueOp(op) { outbox.push(op); idb.transaction('outbox','readwrite').objectStore('outbox').add(op); }
async function flushOutbox() {
  if (!navigator.onLine || outbox.length === 0) return;
  const ops = [...outbox]; outbox = []; await idbClear('outbox');
  for (const op of ops) { try { await apiFetch(op.method, op.path, op.body); } catch(e) { enqueueOp(op); } }
  await fullSync();
}

// ── API ───────────────────────────────────────────────────────
async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiCall(method, path, body) {
  if (!navigator.onLine) { if (method !== 'GET') enqueueOp({ method, path, body }); throw new Error('offline'); }
  return apiFetch(method, path, body);
}

// ── Sync ──────────────────────────────────────────────────────
async function fullSync() {
  try {
    const data = await apiFetch('GET', '/sync');
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
    lastSyncHash = hashData(data);
    renderNotesList(); renderTagsBar(); renderBoardsBar();
    if (currentTab === 'calendar') renderCalendarActive();
    if (currentTab === 'calls') renderCallLog();
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
let lastSyncHash = '';

function hashData(data) {
  const ts = (data.tasks||[]).map(t=>t.id+':'+t.updated_at+':'+t.column_id).sort().join('|');
  const ns = (data.notes||[]).map(n=>n.id+':'+n.updated_at).sort().join('|');
  const rs = (data.reminders||[]).map(r=>r.id+':'+r.updated_at+':'+(r.next_fire_at||0)+':'+(r.snoozed_until||0)).sort().join('|');
  const cs = (data.calls||[]).map(c=>c.id+':'+c.status+':'+(c.recording_sid||'')).sort().join('|');
  return ts + '$$' + ns + '$$' + rs + '$$' + cs;
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
    const data = await apiFetch('GET', '/sync');
    const hash = hashData(data);
    if (hash === lastSyncHash) return;
    lastSyncHash = hash;
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
    renderNotesList(); renderTagsBar(); renderBoardsBar();
    if (currentTab === 'calendar') renderCalendarActive();
    if (currentTab === 'calls') renderCallLog();
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
function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  sessionStorage.removeItem('ws_auth');
  clearUploadsCookie();
  clearSwAuth();
  pinBuffer = ''; updatePinDots();
}
async function tryLogin(pin) {
  authHeader = 'Basic ' + btoa('workspace:' + pin);
  try {
    await apiFetch('GET', '/auth/check');
    sessionStorage.setItem('ws_auth', authHeader);
    setUploadsCookie();
    mirrorAuthForSw();
    refreshPushSubscription(); // fresh PIN login path was missing this — restore-path only before
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    if (isMobile()) document.getElementById('left-panel').classList.add('collapsed');
    await fullSync();
    outbox = await idbGetAll('outbox');
    if (outbox.length) flushOutbox();
    startPolling();
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
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('left-panel-nav')?.classList.remove('nav-open');
  document.querySelectorAll('.nav-menu-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('notes-view').classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-view').classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-view')?.classList.toggle('hidden', tab !== 'expenses');
  document.getElementById('calendar-view')?.classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('calls-view')?.classList.toggle('hidden', tab !== 'calls');
  document.getElementById('trash-view')?.classList.toggle('hidden', tab !== 'trash');
  document.getElementById('audits-view')?.classList.toggle('hidden', tab !== 'audits');
  document.getElementById('tourist-view')?.classList.toggle('hidden', tab !== 'tourist');
  document.getElementById('daily-tasks-view')?.classList.toggle('hidden', tab !== 'daily-tasks');
  document.getElementById('cold-email-view')?.classList.toggle('hidden', tab !== 'cold-email');
  document.getElementById('notes-panel')?.classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-panel')?.classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-panel')?.classList.toggle('hidden', tab !== 'expenses');
  document.getElementById('calendar-panel')?.classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('calls-panel')?.classList.toggle('hidden', tab !== 'calls');
  document.getElementById('audits-panel')?.classList.toggle('hidden', tab !== 'audits');
  document.getElementById('daily-tasks-panel')?.classList.toggle('hidden', tab !== 'daily-tasks');
  document.getElementById('cold-email-panel')?.classList.toggle('hidden', tab !== 'cold-email');
  if (tab === 'tasks' && boards.length && !currentBoardId) selectBoard(boards[0].id);
  if (tab === 'trash') loadTrash();
  if (tab === 'expenses') loadExpenses();
  if (tab === 'calendar') loadCalendar();
  if (tab === 'calls') loadCallsTab();
  if (tab === 'audits') loadAudits();
  if (tab === 'daily-tasks') loadDailyTasks();
  if (tab === 'cold-email') loadColdEmail();
  if (tab !== 'expenses') { selectedExpenses.clear(); lastClickedExpenseId = null; }
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

function setTagColor(name, color) {
  const stored = JSON.parse(localStorage.getItem('tag-colors') || '{}');
  stored[name] = color;
  localStorage.setItem('tag-colors', JSON.stringify(stored));
  renderTagsBar(); renderNotesList(); renderTagEditor();
}

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
    area.innerHTML = '<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;">Select or create a note &nbsp;<span style="color:#2a2a2a;font-size:12px;">⌘K to search</span></div>';
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
  if (!bar) return;
  const cats = [...new Set(expenses.map(e => e.category).filter(Boolean))].sort();
  if (!cats.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
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
    case 'payee':    return `<span class="expense-entry-payee">${escHtml(e.payee || '—')}</span>`;
    case 'note':     return `<span class="expense-entry-note">${escHtml(e.note || '')}</span>`;
    case 'source':    return `<span class="expense-entry-source">${escHtml(e.source || '')}</span>`;
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
const EXPENSE_CHART_SOURCES = [
  { key: 'Chase Debit',  color: '#4caf32' },
  { key: 'Chase Credit', color: '#4a90e0' },
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
    if (!e.date || e.direction === 'deposit' || !EXPENSE_CHART_SOURCES.some(s => s.key === e.source)) continue;
    (bySource[e.source] ??= {})[e.date.slice(0, 7)] = (bySource[e.source]?.[e.date.slice(0, 7)] || 0) + e.amount;
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
        <div class="exp-chart-legend">${legend}</div>
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
      ${hasFilter ? '<button id="expense-time-clear-btn" class="expense-time-clear-btn">Clear</button>' : ''}
    </div>`;
}

function renderExpensesList() {
  const area = document.getElementById('expenses-list-area');
  if (!area) return;
  let filtered = activeExpenseCat ? expenses.filter(e => e.category === activeExpenseCat) : expenses;
  if (expenseFilterYear !== 'all') filtered = filtered.filter(e => e.date?.slice(0, 4) === expenseFilterYear);
  if (expenseFilterMonth !== 'all') filtered = filtered.filter(e => e.date?.slice(5, 7) === expenseFilterMonth);

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

  area.innerHTML = `
    <div class="exp-sticky-header">
      <div class="exp-bulk-bar${anySelected ? '' : ' hidden'}">
        <span class="exp-bulk-count">${selectedExpenses.size} selected</span>
        <button class="exp-bulk-delete">Delete selected</button>
        <button class="exp-bulk-clear">Clear</button>
      </div>
      <div class="expense-list-header">
        <span class="expense-list-label">${activeExpenseCat ? escHtml(activeExpenseCat) : 'All expenses'}</span>
        <span class="expense-list-header-right">
          <button class="expense-chart-toggle-btn" id="expense-chart-toggle-btn">${expenseChartVisible ? '📈 Hide chart' : '📈 Chart'}</button>
          <button class="expense-add-btn" id="expense-add-inline-btn">+ Add expense</button>
        </span>
      </div>
      ${expenseTimeFilterHtml()}
      ${expenseChartVisible ? expenseChartHtml(filtered) : ''}
      ${filtered.length ? headerRow : ''}
    </div>
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
  const today = new Date().toISOString().slice(0, 10);
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
  const body = { amount, date: isoDate, category, payee, source, frequency, direction, note };
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
        <button class="agenda-del-btn" data-id="${r.id}" title="Delete">🗑</button>
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
    btn.addEventListener('click', e => { e.stopPropagation(); deleteReminder(btn.dataset.id); });
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

// Called with an explicit id from the inline agenda 🗑, without one from the
// modal's Delete button (falls back to the open reminder).
async function deleteReminder(id) {
  id = typeof id === 'string' ? id : currentReminderId;
  if (!id) return;
  if (!confirm('Delete this reminder?')) return;
  reminders = reminders.filter(r => r.id !== id);
  if (id === currentReminderId) closeReminderModal();
  renderCalendarActive();
  try { await apiCall('DELETE', '/reminders/' + id); } catch(e) {}
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
  const el = document.getElementById('calls-usage-info');
  if (!el) return;
  try {
    const u = await apiFetch('GET', '/twilio/usage');
    el.innerHTML = `Balance <b>${escHtml(fmtUsd(u.balance))}</b> · today ${escHtml(fmtUsd(u.spentToday))} · this month ${escHtml(fmtUsd(u.spentThisMonth))}`;
  } catch(e) { el.innerHTML = ''; } // not configured / offline — just stay quiet, dialer status already covers real errors
}

async function loadCallsTab() {
  try { calls = await apiFetch('GET', '/calls'); } catch(e) {}
  renderCallLog();
  initDialer();
  loadUsagePanel();
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
    setDialerStatus('In call · ' + fmtCallDur(Math.round((Date.now() - start) / 1000)), 'dialer-status-live');
  }, 1000);
  setDialerStatus('In call · 0:00', 'dialer-status-live');
}

function endCallUi() {
  clearInterval(callTimerInt); callTimerInt = null;
  twCall = null;
  twDialing = false;
  document.getElementById('dial-call-btn')?.classList.remove('hidden');
  document.getElementById('dial-hangup-btn')?.classList.add('hidden');
  setDialerStatus('Ready', 'dialer-status-ready');
  // The recording takes a few seconds to process server-side; the 2s sync
  // poll picks it up (hashData covers recording_sid), no refresh needed here.
  loadUsagePanel(); // balance just moved
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
  setDialerStatus('Connecting…');
  document.getElementById('dial-call-btn').classList.add('hidden');
  document.getElementById('dial-hangup-btn').classList.remove('hidden');
  try {
    // Triggers the mic permission prompt on first use.
    twCall = await twDevice.connect({ params: { To: num } });
  } catch(e) {
    console.warn('twilio connect failed:', e);
    const msg = String(e && (e.message || e.name) || '');
    toast(/Permission|NotAllowed/i.test(msg) ? 'Microphone blocked — allow it in browser settings' : 'Could not start call');
    endCallUi();
    return;
  }
  twCall.on('ringing', () => setDialerStatus('Ringing ' + fmtPhone(num) + '…'));
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

function renderCallLog() {
  const log = document.getElementById('call-log');
  if (!log) return;
  // The 2s sync poll re-renders on ANY data change (notes, reminders, …) —
  // an innerHTML rebuild would silently kill a recording mid-playback. Hold
  // the re-render while a player is open; it catches up once it's closed.
  if (log.querySelector('audio')) return;
  if (!calls.length) {
    log.innerHTML = '<div class="agenda-empty">No calls yet — dial a number above</div>';
    return;
  }
  log.innerHTML = '<div class="agenda-section-label">Call log</div>' + calls.map(c => {
    const st = CALL_STATUS_LABEL[c.status] || { label: c.status, cls: 'call-status-dim' };
    return `<div class="call-item" data-id="${c.id}">
      <div class="call-item-main">
        <div class="call-item-number">${escHtml(fmtPhone(c.to_number))}</div>
        <div class="call-item-meta">
          <span class="agenda-time agenda-time-neutral">${escHtml(fmtFireTime(c.started_at))}</span>
          <span class="call-status ${st.cls}">${escHtml(st.label)}</span>
          ${c.duration ? `<span class="call-dur">${escHtml(fmtCallDur(c.duration))}</span>` : ''}
        </div>
        <div class="call-audio-slot" id="call-audio-${escHtml(c.recording_sid || c.id)}"></div>
      </div>
      ${c.recording_sid ? `
        <button class="call-play-btn" data-sid="${escHtml(c.recording_sid)}" title="Play recording">▶</button>
        <button class="call-dl-btn" data-sid="${escHtml(c.recording_sid)}" data-num="${escHtml(c.to_number)}" data-ts="${c.started_at}" title="Download recording">↓</button>` : ''}
      <button class="call-del-btn" data-id="${escHtml(c.id)}" title="Delete call">🗑</button>
    </div>`;
  }).join('');
  log.querySelectorAll('.call-play-btn').forEach(btn => {
    btn.addEventListener('click', () => playRecording(btn.dataset.sid, btn));
  });
  log.querySelectorAll('.call-dl-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadRecording(btn.dataset.sid, btn.dataset.num, +btn.dataset.ts));
  });
  log.querySelectorAll('.call-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteCall(btn.dataset.id));
  });
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
      // If this exact recording is the one currently playing, clear its slot
      // first — otherwise renderCallLog's "don't kill a playing recording"
      // guard would block the re-render and leave the deleted row on screen.
      document.getElementById('call-audio-' + sid)?.replaceChildren();
    }
    calls = calls.filter(c => c.id !== callId);
    renderCallLog();
    toast('Call deleted');
  } catch(e) { toast('Could not delete — check connection'); }
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

async function renameTagGlobally(oldName, newName) {
  if (!newName || newName === oldName) return;
  const allIDB = await idbGetAll('notes');
  allIDB.forEach(n => { if (!notesFullCache[n.id]) notesFullCache[n.id] = n; });
  const colors = JSON.parse(localStorage.getItem('tag-colors') || '{}');
  if (colors[oldName]) { colors[newName] = colors[oldName]; delete colors[oldName]; }
  localStorage.setItem('tag-colors', JSON.stringify(colors));
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
}

function allTagNames() {
  const all = new Set();
  notes.forEach(n => { const f = notesFullCache[n.id] || n; noteTags(f).forEach(t => all.add(t)); });
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
  const renderDropdown = () => {
    if (!dropdown) return;
    const applied = noteTags(notesFullCache[currentNoteId] || {});
    const q = (input?.value || '').trim().toLowerCase();
    opts = allTagNames().filter(t => !applied.includes(t) && t.toLowerCase().includes(q));
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

// ── Task tags (separate namespace from note tags) ──────────────
function taskTags(task) {
  return (task && task.tags ? task.tags : '').split(',').map(t => t.trim()).filter(Boolean);
}

function taskTagColor(name) {
  const stored = JSON.parse(localStorage.getItem('task-tag-colors') || '{}');
  if (stored[name]) return stored[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 55, 55);
}

function setTaskTagColor(name, color) {
  const stored = JSON.parse(localStorage.getItem('task-tag-colors') || '{}');
  stored[name] = color;
  localStorage.setItem('task-tag-colors', JSON.stringify(stored));
  renderTaskTagsBar(); renderKanban(); renderTaskTagEditor();
}

async function allTaskTagNames() {
  const all = new Set();
  currentBoardData.forEach(col => col.tasks.forEach(t => taskTags(t).forEach(x => all.add(x))));
  (await idbGetAll('tasks')).forEach(t => taskTags(t).forEach(x => all.add(x)));
  return [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function renderTaskTagsBar() {
  const bar = document.getElementById('task-tags-bar');
  if (!bar) return;
  const allTags = new Set();
  currentBoardData.forEach(col => col.tasks.forEach(t => taskTags(t).forEach(x => allTags.add(x))));
  if (!allTags.size) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = '';
  bar.innerHTML = [...allTags].sort().map(t => {
    const c = taskTagColor(t);
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

async function renameTaskTagGlobally(oldName, newName) {
  if (!newName || newName === oldName) return;
  const colors = JSON.parse(localStorage.getItem('task-tag-colors') || '{}');
  if (colors[oldName]) { colors[newName] = colors[oldName]; delete colors[oldName]; }
  localStorage.setItem('task-tag-colors', JSON.stringify(colors));
  const rename = list => list.includes(oldName) ? list.map(t => t === oldName ? newName : t).join(',') : null;
  const idbTasks = await idbGetAll('tasks');
  for (const t of idbTasks) {
    const merged = rename(taskTags(t));
    if (merged === null) continue;
    t.tags = merged; t.updated_at = Date.now();
    await idbPut('tasks', t);
    try { await apiCall('PUT', '/tasks/'+t.id, { tags: t.tags }); } catch(e) {}
  }
  currentBoardData.forEach(col => col.tasks.forEach(t => {
    const merged = rename(taskTags(t));
    if (merged !== null) t.tags = merged;
  }));
  if (modalTaskTags.includes(oldName)) modalTaskTags = modalTaskTags.map(t => t === oldName ? newName : t);
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
    const c = taskTagColor(t);
    return `<span class="note-tag editable" style="--tag-c:${c}"><span class="tag-color-dot" data-tag="${escHtml(t)}" style="background:${c}" title="Change color"></span><span class="tag-name" data-tag="${escHtml(t)}" title="Double-click to rename">${escHtml(t)}</span><button class="tag-remove-btn" data-tag="${escHtml(t)}">×</button></span>`;
  }).join('') + `<span class="tag-add-wrap" id="task-tag-add-wrap"><input class="tag-input" id="task-tag-input" placeholder="tag" autocomplete="off"><button class="tag-add-btn" id="task-tag-add-btn" title="Pick an existing tag">+</button><div class="tag-dropdown" id="task-tag-dropdown" hidden></div></span>`;
  el.querySelectorAll('.tag-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = taskTagColor(dot.dataset.tag);
      inp.addEventListener('input', () => setTaskTagColor(dot.dataset.tag, inp.value));
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
        await renameTaskTagGlobally(oldName, newName || oldName);
        renderTaskTagEditor(); renderTaskTagsBar(); renderKanban();
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
    const all = await allTaskTagNames();
    opts = all.filter(t => !modalTaskTags.includes(t) && t.toLowerCase().includes(q));
    activeIndex = -1;
    if (!opts.length) {
      dropdown.innerHTML = `<div class="tag-dropdown-empty">${q ? 'No matching tags' : 'No other tags yet'}</div>`;
      return;
    }
    dropdown.innerHTML = opts.map(t =>
      `<div class="tag-dropdown-item" data-tag="${escHtml(t)}"><span class="tag-color-dot" style="background:${taskTagColor(t)}"></span>${escHtml(t)}</div>`
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
      <button class="del-note-btn tb-btn" id="del-note-btn" title="Delete note"><span class="tb-icon">🗑</span><span class="tb-label">Delete</span></button>
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
  document.getElementById('del-note-btn').addEventListener('click', deleteCurrentNote);
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

async function deleteCurrentNote() {
  if (!currentNoteId) { toast('No note open'); return; }
  if (!confirm('Delete this note?')) return;
  const id = currentNoteId;
  notes = notes.filter(n => n.id !== id); delete notesFullCache[id];
  await idbDelete('notes', id); currentNoteId = null;
  WEditor.destroy(noteEditor); noteEditor = null;
  renderNotesList(); renderTagsBar(); // renderNotesList repopulates the empty-state grid
  try { await apiCall('DELETE', '/notes/'+id); } catch(e) {}
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
    await enqueueOp({ method:'POST', path:'/notes', body:{ title, content:'' } });
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
const COMMANDS = [
  { label: 'New Note',             icon: '📝', action: () => { switchTab('notes'); newNote(); } },
  { label: 'Share Note as .md',    icon: '↗',  action: shareCurrentNote },
  { label: 'Delete Current Note',  icon: '🗑', action: deleteCurrentNote },
  { label: 'Import .md Files',     icon: '⬆',  action: () => document.getElementById('import-input').click() },
  { label: 'New Board',            icon: '📋', action: () => { switchTab('tasks'); promptNewBoard(); } },
  { label: 'New Column',           icon: '+',  action: () => { switchTab('tasks'); promptNewColumn(); } },
  { label: 'Delete Current Board', icon: '🗑', action: deleteCurrentBoard },
  { label: 'Switch to Notes',      icon: '📄', action: () => switchTab('notes') },
  { label: 'Switch to Projects',   icon: '✓',  action: () => switchTab('tasks') }, // UI calls this tab "Projects"
  { label: 'Switch to Expenses',   icon: '$',  action: () => switchTab('expenses') },
  { label: 'New Expense',          icon: '$',  action: () => { switchTab('expenses'); openExpenseModal(); } },
  { label: 'Export Expenses CSV',  icon: '↓',  action: exportExpensesCsv },
  { label: 'Switch to Calendar',   icon: '📅', action: () => switchTab('calendar') },
  { label: 'New Reminder',         icon: '⏰', action: () => { switchTab('calendar'); openReminderModal(); } },
  { label: 'Switch to Calls',      icon: '📞', action: () => switchTab('calls') },
  { label: 'New Call',             icon: '📞', action: () => { switchTab('calls'); setTimeout(() => document.getElementById('dial-number')?.focus(), 50); } },
  { label: 'Switch to Tourist',    icon: '🧭', action: () => switchTab('tourist') },
  { label: 'Switch to TRW Daily Tasks', icon: '📝', action: () => switchTab('daily-tasks') },
  { label: 'New Daily Task',       icon: '📝', action: () => { switchTab('daily-tasks'); newDailyTaskPaste(); } },
  { label: 'Open Trash',           icon: '🗑', action: () => switchTab('trash') },
];

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

  const cmdResults = COMMANDS.filter(c => c.label.toLowerCase().includes(ql)).slice(0, 5);

  searchFlat = [
    ...noteResults.map(n => ({ type: 'note', data: n })),
    ...boardResults.map(b => ({ type: 'board', data: b })),
    ...taskResults.map(t => ({ type: 'task', data: t })),
    ...cmdResults.map(c => ({ type: 'cmd', data: c })),
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
  if (cmdResults.length) {
    html += `<div class="search-section-header">Commands</div>`;
    for (const c of cmdResults) {
      html += `<div class="search-item" data-fi="${fi++}">
        <span class="search-item-icon">${c.icon}</span>
        <div class="search-item-body"><div class="search-item-title">${escHtml(c.label)}</div></div>
      </div>`;
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
  else if (item.type === 'cmd') { item.data.action(); }
}

// ── Boards ─────────────────────────────────────────────────────
function renderBoardsBar() {
  const list = document.getElementById('boards-list');
  list.innerHTML = boards.map(b => `
    <div class="board-item${b.id===currentBoardId?' active':''}" draggable="true" data-bid="${b.id}">
      <span class="board-item-name">${escHtml(b.name)}</span>
      <button class="board-item-del" data-id="${b.id}" title="Delete board">✕</button>
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
  list.querySelectorAll('.board-item-del').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); deleteBoard(el.dataset.id); }));
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

async function deleteBoard(id) {
  const board = boards.find(b => b.id === id);
  if (!board || !confirm(`Delete board "${board.name}" and all its data?`)) return;
  boards = boards.filter(b => b.id !== id);
  if (currentBoardId === id) { currentBoardId = boards.length ? boards[0].id : null; currentBoardData = []; }
  await idbDelete('boards', id); renderBoardsBar();
  if (currentBoardId) await loadBoard(currentBoardId); else renderKanban();
  try { await apiCall('DELETE', '/boards/'+id); } catch(e) {}
}
async function deleteCurrentBoard() {
  if (!currentBoardId) { toast('No board selected'); return; }
  deleteBoard(currentBoardId);
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
  const show = isMobile() && currentBoardData.length > 0;
  nav.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const col = currentBoardData[mobileColIdx];
  const label = document.getElementById('col-nav-label');
  if (label && col) label.textContent = `${col.name}  ${mobileColIdx + 1}/${currentBoardData.length}`;
  const prevBtn = document.getElementById('prev-col-btn');
  const nextBtn = document.getElementById('next-col-btn');
  if (prevBtn) prevBtn.disabled = mobileColIdx === 0;
  if (nextBtn) nextBtn.disabled = mobileColIdx >= currentBoardData.length - 1;
}
function goToMobileCol(idx) {
  if (!currentBoardData.length) return;
  mobileColIdx = Math.max(0, Math.min(idx, currentBoardData.length - 1));
  const board = document.getElementById('kanban-board');
  if (board) board.scrollLeft = mobileColIdx * board.clientWidth;
  updateMobileColNav();
}

// ── Kanban render ──────────────────────────────────────────────
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
  if (!currentBoardData.length) {
    area.innerHTML = `<div class="no-board-msg"><span>No columns yet.</span><button id="first-col-btn">+ Add a column</button></div>`;
    document.getElementById('first-col-btn')?.addEventListener('click', promptNewColumn);
    return;
  }
  area.innerHTML = `<div class="kanban-board" id="kanban-board"></div>`;
  const board = document.getElementById('kanban-board');
  currentBoardData.forEach(col => board.appendChild(createColEl(col)));
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
  let movedTask = null;
  for (const c of currentBoardData) {
    const idx = c.tasks.findIndex(t => t.id === taskId);
    if (idx >= 0) { [movedTask] = c.tasks.splice(idx, 1); movedTask.column_id = targetColId; break; }
  }
  if (!movedTask) return;
  const targetCol = currentBoardData.find(c => c.id === targetColId);
  if (!targetCol) return;
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

function createTaskEl(task, col) {
  const inDone = isDoneCol(col);
  const el = document.createElement('div');
  el.className = 'task-card' + (selectedTasks.has(task.id) ? ' selected' : '');
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
    ${tags.length ? `<div class="note-item-tags">${tags.map(t=>`<span class="note-tag" style="--tag-c:${taskTagColor(t)}">${escHtml(t)}</span>`).join('')}</div>` : ''}
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
  if(!selectedTasks.size||!confirm(`Delete ${selectedTasks.size} task(s)?`)) return;
  const ids=[...selectedTasks];
  for(const col of currentBoardData) col.tasks=col.tasks.filter(t=>!selectedTasks.has(t.id));
  for(const id of ids) await idbDelete('tasks',id);
  selectedTasks.clear(); updateBulkActions(); renderKanban();
  try { await apiCall('DELETE','/tasks',{ids}); } catch(e) {}
}

// ── Task Modal ─────────────────────────────────────────────────
function populateColSelectForBoard(boardId, colId) {
  const sel = document.getElementById('modal-col-select');
  if (!sel) return;
  const cols = boardId === currentBoardId
    ? currentBoardData.slice()
    : allColumns.filter(c => c.board_id === boardId).sort((a, b) => a.position - b.position);
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
      await enqueueOp({ method:'POST', path:'/tasks', body:{ column_id: newTaskColId, title, description, claude_marked, tags } });
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

async function deleteTaskFromModal() {
  if (modalTaskId === 'new') { destroyTaskModal(); return; }
  if (!confirm('Delete this task?')) return;
  const id = modalTaskId;
  for (const col of currentBoardData) col.tasks = col.tasks.filter(t => t.id !== id);
  selectedTasks.delete(id); updateBulkActions(); destroyTaskModal();
  await idbDelete('tasks', id); renderKanban();
  try { await apiCall('DELETE', '/tasks/'+id); } catch(e) {}
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

  if (mod && e.key === 'k') {
    e.preventDefault();
    const inp = document.getElementById('search-input');
    document.getElementById('search-bar-wrap').classList.add('mobile-open');
    inp.focus(); inp.select();
    return;
  }
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
document.getElementById('lock-btn').addEventListener('click', showLogin);
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
// Nav dropdown: collapsed to just the active section by default (app.css
// hides every non-active .nav-row); its own ▾ opens the full list.
document.getElementById('left-panel-nav').addEventListener('click', e => {
  if (!e.target.closest('.nav-expand-btn')) return;
  e.stopPropagation();
  document.getElementById('left-panel-nav').classList.toggle('nav-open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#left-panel-nav')) document.getElementById('left-panel-nav').classList.remove('nav-open');
});
// Drag-to-reorder the nav tabs themselves (Notes/Projects/Expenses/Calendar).
// Rows are static markup (not re-rendered from an array), so reordering just
// moves the existing DOM nodes — listeners already attached to them travel
// along for free. Order persists the same way as expense-col-order.
(() => {
  const nav = document.getElementById('left-panel-nav');
  let dragEl = null;
  function applyNavOrder() {
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
  function saveNavOrder() {
    localStorage.setItem('nav-tab-order', JSON.stringify([...nav.querySelectorAll('.nav-row')].map(r => r.dataset.tab)));
  }
  // Touch devices never fire HTML5 drag events at all — the ▲/▼ buttons
  // (shown only on coarse pointers, see app.css) are the touch equivalent.
  function updateReorderBtnStates() {
    const rows = [...nav.querySelectorAll('.nav-row')];
    rows.forEach((row, i) => {
      row.querySelector('.nav-up-btn').disabled = i === 0;
      row.querySelector('.nav-down-btn').disabled = i === rows.length - 1;
    });
  }
  function moveRow(row, dir) {
    const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    dir < 0 ? nav.insertBefore(row, sib) : nav.insertBefore(sib, row);
    saveNavOrder(); updateReorderBtnStates();
  }
  applyNavOrder();
  updateReorderBtnStates();
  nav.addEventListener('click', e => {
    const btn = e.target.closest('.nav-up-btn, .nav-down-btn');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    moveRow(btn.closest('.nav-row'), btn.classList.contains('nav-up-btn') ? -1 : 1);
  });
  nav.querySelectorAll('.nav-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragEl = row;
      e.dataTransfer.setData('nav-row-drag', row.dataset.tab);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      nav.querySelectorAll('.nav-row').forEach(r => r.classList.remove('drop-above', 'drop-below'));
      dragEl = null;
    });
    row.addEventListener('dragover', e => {
      if (!Array.from(e.dataTransfer.types).includes('nav-row-drag') || row === dragEl) return;
      e.preventDefault();
      const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
      row.classList.toggle('drop-above', e.clientY < mid);
      row.classList.toggle('drop-below', e.clientY >= mid);
    });
    row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-above', 'drop-below'); });
    row.addEventListener('drop', e => {
      if (!dragEl || dragEl === row) return;
      e.preventDefault();
      const insertBefore = row.classList.contains('drop-above');
      row.classList.remove('drop-above', 'drop-below');
      nav.insertBefore(dragEl, insertBefore ? row : row.nextSibling);
      saveNavOrder(); updateReorderBtnStates();
    });
  });
})();
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
document.getElementById('reminder-modal-delete').addEventListener('click', deleteReminder);
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
// Calls / dialer
document.getElementById('new-call-btn').addEventListener('click', () => {
  switchTab('calls');
  if (isMobile()) closeSidebar();
  setTimeout(() => document.getElementById('dial-number')?.focus(), 50);
});
document.getElementById('dial-pad').addEventListener('click', e => {
  const k = e.target.closest('.dial-key');
  if (k) dialKeyPress(k.dataset.k);
});
document.getElementById('dial-back').addEventListener('click', () => {
  const i = document.getElementById('dial-number');
  i.value = i.value.slice(0, -1); i.focus();
});
document.getElementById('dial-call-btn').addEventListener('click', startCall);
document.getElementById('new-audit-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('audits'); newAudit(); });
document.getElementById('new-daily-task-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('daily-tasks'); newDailyTaskPaste(); });
document.getElementById('cold-email-refresh-btn').addEventListener('click', e => { e.stopPropagation(); switchTab('cold-email'); refreshColdEmail(); });
document.getElementById('dial-hangup-btn').addEventListener('click', hangUp);
document.getElementById('dial-number').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); startCall(); }
});
document.getElementById('bulk-delete-btn').addEventListener('click',bulkDeleteTasks);
document.getElementById('cancel-sel-btn').addEventListener('click',()=>{selectedTasks.clear();updateBulkActions();renderKanban();});
document.getElementById('modal-close').addEventListener('click',closeTaskModal);
document.getElementById('modal-delete').addEventListener('click',deleteTaskFromModal);
document.getElementById('modal-claude-mark').addEventListener('click',()=>setClaudeMarkBtn(!modalClaudeMarked));
document.getElementById('modal-board-select')?.addEventListener('change', e => {
  const colSel = document.getElementById('modal-col-select');
  const currentCol = colSel?.value;
  populateColSelectForBoard(e.target.value, currentCol);
});
document.getElementById('task-modal').addEventListener('click',e=>{if(e.target===document.getElementById('task-modal'))closeTaskModal();});

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

async function newAudit() {
  const data = emptyAuditData();
  try {
    const created = await apiCall('POST', '/audits', { business_name: 'Untitled audit', data });
    audits.unshift({ id: created.id, business_name: created.business_name, status: created.status, report_type: data.report_type, updated_at: created.updated_at });
    currentAuditId = created.id;
    currentAudit = created;
    renderAuditsList();
    renderAuditEditor();
  } catch (e) { toast('Could not create audit'); }
}

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
  area.innerHTML = `
    <div class="audit-toolbar">
      <input type="text" id="audit-business-name" placeholder="Business name" value="${escHtml(d.identity.business_name || '')}">
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
let dailyTaskDraft = null; // { category, task_date, source_url, questions: [{question, answer}] }
const DAILY_TASK_CAT_LABELS = { business_masters: 'Business Master', daily_marketing: 'Daily Marketing', daily_seo_task: 'Daily SEO Task' };

// TRW's raw prompt block and its own already-answered .md files use two
// DIFFERENT shapes for the same content: an answered file has each question
// as its own **bold** line; a fresh unanswered paste instead has ONE bold
// instruction line (e.g. "**Answer the questions:**") followed by a bullet
// list of the real questions. Parse bold lines first, then explode any pair
// whose entire "answer" turned out to be pure bullet lines into one question
// per bullet — this only fires for the fresh-paste shape (a real answered
// pair's answer is prose, not bullets-only) except the rare case where a
// genuine question's answer itself IS a bullet list (e.g. "list 10 niches");
// that's why the form always keeps a per-question ✕ to undo a bad split.
function parseQABlock(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  let sourceUrl = '';
  if (i < lines.length && /^https?:\/\//.test(lines[i].trim())) { sourceUrl = lines[i].trim(); i++; }
  const pairs = [];
  let current = null;
  const qRe = /^\s*\*\*(.+?)\*\*:?\s*(.*)$/;
  for (; i < lines.length; i++) {
    const m = lines[i].match(qRe);
    if (m) {
      if (current) pairs.push(current);
      current = { question: m[1].trim(), answer: m[2] ? m[2].trim() : '' };
    } else if (current) {
      current.answer += (current.answer ? '\n' : '') + lines[i];
    }
  }
  if (current) pairs.push(current);
  pairs.forEach(p => { p.answer = p.answer.replace(/^\n+|\n+$/g, ''); });

  const bulletRe = /^\s*[-*]\s+(.+)$/;
  const exploded = [];
  for (const p of pairs) {
    const answerLines = p.answer.split('\n').filter(l => l.trim() !== '');
    const allBullets = answerLines.length > 0 && answerLines.every(l => bulletRe.test(l));
    if (allBullets) {
      answerLines.forEach(l => exploded.push({ question: l.match(bulletRe)[1].trim(), answer: '' }));
    } else {
      exploded.push(p);
    }
  }
  return { sourceUrl, pairs: exploded };
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
    return `<span class="tag-filter-pill${active ? ' active' : ''}" data-cat="${cat}" style="--tag-c:${tagColor(label)}">${escHtml(label)}</span>`;
  }).join('') + (currentDailyTaskCategory ? `<span class="tag-filter-clear" id="daily-task-cat-clear">✕</span>` : '');
  bar.querySelectorAll('.tag-filter-pill').forEach(el => {
    el.addEventListener('click', () => {
      currentDailyTaskCategory = el.dataset.cat === currentDailyTaskCategory ? null : el.dataset.cat;
      renderDailyTaskCatBar(); renderDailyTasksList();
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
  dailyTaskDraft = { category: t.category, task_date: t.task_date, source_url: t.source_url, questions: t.questions.map(q => ({ ...q })) };
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
      <textarea id="dt-paste-raw" class="daily-task-paste-box" placeholder="Paste the daily task prompt block here (link + **bolded questions**)…"></textarea>
      <button class="save-btn" id="dt-parse-btn">Parse into a form</button>
    </div>`;
  document.getElementById('dt-paste-date').valueAsDate = new Date();
  document.getElementById('dt-parse-btn').addEventListener('click', () => {
    const raw = document.getElementById('dt-paste-raw').value;
    const { sourceUrl, pairs } = parseQABlock(raw);
    if (!pairs.length) { toast('Could not find any **bolded** questions in that text'); return; }
    dailyTaskDraft = {
      category: document.getElementById('dt-paste-category').value,
      task_date: document.getElementById('dt-paste-date').value,
      source_url: sourceUrl,
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
        ${d.source_url ? `<a href="${escHtml(d.source_url)}" target="_blank" rel="noopener" class="daily-task-source-link">Open source ↗</a>` : ''}
      </div>
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
  document.getElementById('dt-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(formatQABlock(d.source_url, d.questions)).then(() => toast('Copied'));
  });
  document.getElementById('dt-save-btn').addEventListener('click', saveDailyTask);
  document.getElementById('dt-delete-btn')?.addEventListener('click', deleteCurrentDailyTask);
}

async function saveDailyTask() {
  const d = dailyTaskDraft;
  if (!d.task_date) { toast('Date required'); return; }
  const body = { category: d.category, task_date: d.task_date, source_url: d.source_url, questions: d.questions };
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
      outbox = await idbGetAll('outbox');
      if(outbox.length) flushOutbox();
      startPolling();
    } catch(e) { showLogin(); }
  }
})();
