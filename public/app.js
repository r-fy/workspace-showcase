'use strict';

// ── Config ────────────────────────────────────────────────────
const API = '/api';
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

let boards = [];
let currentBoardId = null;
let currentBoardData = [];
let selectedTasks = new Set();
let modalTaskId = null;
let newTaskColId = null;
let dragColId = null;
let dragBoardId = null;
let dragNoteId = null;
let mobileColIdx = 0;
let allColumns = [];

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
    lastSyncHash = hashData(data);
    renderNotesList(); renderTagsBar(); renderBoardsBar();
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
  return ts + '$$' + ns;
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
    renderNotesList(); renderTagsBar(); renderBoardsBar();
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
function inlineMd(s) {
  s = escHtml(s);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  s = s.replace(/_(.+?)_/g,'<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g,'<del>$1</del>');
  s = s.replace(/`([^`]+)`/g,'<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

// ── Toast ──────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Auth ───────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  sessionStorage.removeItem('ws_auth');
  pinBuffer = ''; updatePinDots();
}
async function tryLogin(pin) {
  authHeader = 'Basic ' + btoa('workspace:' + pin);
  try {
    await apiFetch('GET', '/auth/check');
    sessionStorage.setItem('ws_auth', authHeader);
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
    err.textContent = 'Wrong PIN.';
    err.classList.remove('hidden');
    pinBuffer = ''; updatePinDots();
    setTimeout(() => err.classList.add('hidden'), 1800);
  }
}

// ── PIN pad ────────────────────────────────────────────────────
let pinBuffer = '';
function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    document.getElementById('pd-' + i)?.classList.toggle('filled', i < pinBuffer.length);
  }
}
function pinDigit(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d; updatePinDots();
  if (pinBuffer.length === 4) setTimeout(() => tryLogin(pinBuffer), 80);
}
function pinBack() { pinBuffer = pinBuffer.slice(0, -1); updatePinDots(); }

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
  document.querySelectorAll('.nav-menu-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('notes-view').classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-view').classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-view')?.classList.toggle('hidden', tab !== 'expenses');
  document.getElementById('trash-view')?.classList.toggle('hidden', tab !== 'trash');
  document.getElementById('notes-panel')?.classList.toggle('hidden', tab !== 'notes');
  document.getElementById('tasks-panel')?.classList.toggle('hidden', tab !== 'tasks');
  document.getElementById('expenses-panel')?.classList.toggle('hidden', tab !== 'expenses');
  if (tab === 'tasks' && boards.length && !currentBoardId) selectBoard(boards[0].id);
  if (tab === 'trash') loadTrash();
  if (tab === 'expenses') loadExpenses();
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
  const emptyBtn = document.getElementById('empty-trash-btn');
  if (emptyBtn) emptyBtn.disabled = !notes.length && !tasks.length;
  if (!notes.length && !tasks.length) {
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

function dpInit(iso) {
  const d = dpFromIso(iso) || new Date();
  dpYear = d.getFullYear(); dpMonth = d.getMonth();
  document.getElementById('exp-date-cal')?.classList.add('hidden');
}

function dpRender() {
  const cal = document.getElementById('exp-date-cal');
  const input = document.getElementById('exp-date');
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

document.getElementById('exp-date-trigger').addEventListener('click', e => {
  e.stopPropagation();
  const cal = document.getElementById('exp-date-cal');
  if (cal.classList.contains('hidden')) {
    const typed = dpFromMdy(document.getElementById('exp-date')?.value);
    if (typed) { dpYear = typed.getFullYear(); dpMonth = typed.getMonth(); }
    dpRender(); cal.classList.remove('hidden');
  } else cal.classList.add('hidden');
});
document.addEventListener('click', () => document.getElementById('exp-date-cal')?.classList.add('hidden'));

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
  amount:    { label: 'Amount',    width: '80px' },
};
const EXPENSE_COL_DEFAULT = ['date','category','payee','note','source','frequency','amount'];
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
  amount: 'expense-entry-amount',
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
    case 'amount':    return `<span class="expense-entry-amount">${escHtml(fmtAmount(e.amount))}</span>`;
    default: return '';
  }
}

function renderExpensesList() {
  const area = document.getElementById('expenses-list-area');
  if (!area) return;
  let filtered = activeExpenseCat ? expenses.filter(e => e.category === activeExpenseCat) : expenses;

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

  const sourceTotals = {};
  let grandTotal = 0;
  for (const e of filtered) {
    const src = e.source || 'Unknown';
    sourceTotals[src] = (sourceTotals[src] || 0) + e.amount;
    grandTotal += e.amount;
  }
  const sourceSummary = [
    ...Object.entries(sourceTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([src, amt]) => `<span class="exp-source-total"><span class="exp-source-name">${escHtml(src)}</span><span class="exp-source-amt">${escHtml(fmtAmount(amt))}</span></span>`),
    `<span class="exp-source-divider"></span><span class="exp-source-total exp-source-grand"><span class="exp-source-name">Total</span><span class="exp-source-amt">${escHtml(fmtAmount(grandTotal))}</span></span>`
  ].join('');

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
          ${filtered.length ? `<span class="exp-source-totals">${sourceSummary}</span>` : ''}
          <button class="expense-add-btn" id="expense-add-inline-btn">+ Add expense</button>
        </span>
      </div>
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
  const body = { amount, date: isoDate, category, payee, source, frequency, note };
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

async function importExpensesCsv(file) {
  const text = await file.text();
  try {
    const r = await apiCall('POST', '/expenses/import', { csv: text });
    toast(`Imported ${r.imported} expenses`);
    await loadExpenses();
  } catch(e) { toast('Import failed'); }
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
      if (!postDate?.startsWith('05/')) continue;
      if (type === 'ACCT_XFER') continue;
      if (details === 'CREDIT' || details === 'DSLIP') continue;
      if (!postDate || isNaN(amount)) continue;
      rows.push({ date: mdyToIsoDate(postDate), amount: Math.abs(amount),
        payee: cleanChaseCheckingPayee(desc), category: autoCheckingCategory(desc, type),
        source: 'Chase Debit', note: '' });
    } else {
      const txDate = f[0]?.trim();
      const desc   = f[2]?.trim() || '';
      const chaseCat = f[3]?.trim() || '';
      const type   = f[4]?.trim() || '';
      const amount = parseFloat(f[5]);
      if (!txDate?.startsWith('05/')) continue;
      if (type === 'Payment') continue;
      if (!txDate || isNaN(amount)) continue;
      rows.push({ date: mdyToIsoDate(txDate), amount: Math.abs(amount),
        payee: cleanChaseCreditPayee(desc), category: autoCreditCategory(desc, chaseCat),
        source: 'Chase Credit', note: '' });
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
  const total   = rows.reduce((s, r) => s + r.amount, 0);
  const byCat   = {};
  rows.forEach(r => { const k = r.category || 'Uncategorized'; byCat[k] = (byCat[k] || 0) + r.amount; });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `<div class="chase-preview-cat"><span>${escHtml(cat)}</span><span>${escHtml(fmtAmount(amt))}</span></div>`)
    .join('');
  label.textContent = `Import: ${format === 'credit' ? 'Chase Credit Card' : 'Chase Checking'}`;
  preview.innerHTML = `
    <div class="chase-preview-meta">
      <span>${rows.length} May transactions</span>
      <span class="chase-preview-total">${escHtml(fmtAmount(total))}</span>
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
  const lines = ['date,amount,category,payee,source,note'];
  for (const r of rows) lines.push([r.date, r.amount, r.category, r.payee, r.source, r.note].map(csvField).join(','));
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

async function importChaseCSV(file) {
  const text = await file.text();
  const { format, rows } = parseChaseCSV(text);
  if (format === 'unknown') { toast('Unrecognized Chase CSV format'); return; }
  if (!rows.length) { toast('No May 2026 transactions found'); return; }
  openChaseImportPreview(rows, format);
}

async function handleExpenseImport(file) {
  const text = await file.text();
  const { format, rows } = parseChaseCSV(text);
  if (format !== 'unknown') {
    if (!rows.length) { toast('No May 2026 transactions found in this file'); return; }
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
  document.getElementById('del-note-btn').addEventListener('click', async () => {
    if (!confirm('Delete this note?')) return;
    const id = currentNoteId;
    notes = notes.filter(n => n.id !== id); delete notesFullCache[id];
    await idbDelete('notes', id); currentNoteId = null;
    WEditor.destroy(noteEditor); noteEditor = null;
    renderNotesList(); renderTagsBar();
    area.innerHTML = '<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;">Select or create a note &nbsp;<span style="color:#2a2a2a;font-size:12px;">⌘K to search</span></div>';
    try { await apiCall('DELETE', '/notes/'+id); } catch(e) {}
  });
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
  renderNotesList(); renderTagsBar();
  const area = document.getElementById('note-editor-area');
  if (area) area.innerHTML = '<div style="color:#555;font-size:14px;display:flex;align-items:center;justify-content:center;flex:1;">Select or create a note &nbsp;<span style="color:#2a2a2a;font-size:12px;">⌘K to search</span></div>';
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
  { label: 'Share Note as .md',    icon: '↓',  action: shareCurrentNote },
  { label: 'Delete Current Note',  icon: '🗑', action: deleteCurrentNote },
  { label: 'Import .md Files',     icon: '⬆',  action: () => document.getElementById('import-input').click() },
  { label: 'New Board',            icon: '📋', action: () => { switchTab('tasks'); promptNewBoard(); } },
  { label: 'New Column',           icon: '+',  action: () => { switchTab('tasks'); promptNewColumn(); } },
  { label: 'Delete Current Board', icon: '🗑', action: deleteCurrentBoard },
  { label: 'Switch to Notes',      icon: '📄', action: () => switchTab('notes') },
  { label: 'Switch to Tasks',      icon: '✓',  action: () => switchTab('tasks') },
  { label: 'Switch to Expenses',   icon: '$',  action: () => switchTab('expenses') },
  { label: 'New Expense',          icon: '$',  action: () => { switchTab('expenses'); openExpenseModal(); } },
  { label: 'Export Expenses CSV',  icon: '↓',  action: exportExpensesCsv },
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
  currentBoardId = id; selectedTasks.clear(); updateBulkActions();
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
  const el = document.createElement('div');
  el.className = 'kanban-col' + (isDoneCol(col) ? ' col-done' : '');
  el.dataset.colId = col.id;
  el.setAttribute('draggable', 'true');

  el.innerHTML = `
    <div class="col-header">
      <input type="checkbox" class="col-select-all-cb" title="Select all in column">
      <span class="col-name" title="Click to rename">${escHtml(col.name)}</span>
      <span class="col-count">${col.tasks.length}</span>
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

  col.tasks.forEach(task => tasksList.appendChild(createTaskEl(task, col)));
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
  el.innerHTML = `
    <div class="task-card-header">
      <input type="checkbox" class="task-select-cb" ${selectedTasks.has(task.id)?'checked':''}>
      <span class="task-title">${escHtml(task.title)}</span>
      ${hasDesc ? `<span class="task-desc-dot" title="Has description"></span>` : ''}
      <button class="task-done-btn" title="${inDone ? 'Already done' : 'Mark as done'}">✓</button>
    </div>
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
  el.addEventListener('click', e => {
    if (e.target.closest('.task-select-cb') || e.target.closest('.task-done-btn')) return;
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

function openTaskModal(task) {
  modalTaskId = task.id;
  newTaskColId = null;
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

  if (modalTaskId === 'new') {
    const col = currentBoardData.find(c => c.id === newTaskColId);
    if (!col) return;
    try {
      const task = await apiCall('POST', '/tasks', { column_id: newTaskColId, title, description });
      col.tasks.push(task); await idbPut('tasks', task);
    } catch(e) {
      const id = 'local_'+Date.now(), t = Date.now();
      const task = { id, column_id: newTaskColId, title, description, position: col.tasks.length, created_at: t, updated_at: t };
      col.tasks.push(task); await idbPut('tasks', task);
      await enqueueOp({ method:'POST', path:'/tasks', body:{ column_id: newTaskColId, title, description } });
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
        t.title = title; t.description = description;
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
      try { await apiCall('PUT', '/tasks/'+id, { title, description, column_id: newColId }); } catch(e) {}
    } else {
      const colChanged = newColId && newColId !== oldColId;
      const updated = await idbGet('tasks', id);
      const merged = { ...updated, title, description, ...(colChanged ? { column_id: newColId } : {}) };
      if (updated) await idbPut('tasks', merged);
      try { await apiCall('PUT', '/tasks/'+id, { title, description, ...(colChanged ? { column_id: newColId } : {}) }); } catch(e) {}
    }
  }
}

function destroyTaskModal() {
  WEditor.destroy(taskEditor); taskEditor = null;
  document.getElementById('task-modal').classList.add('hidden');
  modalTaskId = null; newTaskColId = null;
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
  if (e.key === 'Escape') {
    if (dropdownOpen) { closeSearch(); return; }
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
    } else if (e.key === 'Enter' && searchIdx >= 0) {
      activateSearch(searchIdx);
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
document.getElementById('add-board-btn').addEventListener('click', promptNewBoard);
document.getElementById('trash-btn').addEventListener('click', () => switchTab('trash'));
document.getElementById('lock-btn').addEventListener('click', showLogin);
document.addEventListener('keydown', e => {
  if (!document.getElementById('login-overlay').classList.contains('hidden')) {
    if (e.key >= '0' && e.key <= '9') pinDigit(e.key);
    else if (e.key === 'Backspace') pinBack();
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
document.getElementById('expense-modal-delete').addEventListener('click', deleteExpense);
document.getElementById('expense-modal').addEventListener('click', e => { if (e.target === document.getElementById('expense-modal')) closeExpenseModal(); });
document.getElementById('export-csv-btn').addEventListener('click', exportExpensesCsv);
document.getElementById('import-csv-input').addEventListener('change', e => { if (e.target.files.length) { handleExpenseImport(e.target.files[0]); e.target.value = ''; } });
document.getElementById('chase-import-close')?.addEventListener('click', () => { document.getElementById('chase-import-modal').classList.add('hidden'); chaseImportPending = null; });
document.getElementById('chase-import-cancel')?.addEventListener('click', () => { document.getElementById('chase-import-modal').classList.add('hidden'); chaseImportPending = null; });
document.getElementById('chase-import-confirm')?.addEventListener('click', confirmChaseImport);
document.getElementById('chase-import-modal')?.addEventListener('click', e => { if (e.target === document.getElementById('chase-import-modal')) { chaseImportPending = null; e.target.classList.add('hidden'); } });
document.getElementById('bulk-delete-btn').addEventListener('click',bulkDeleteTasks);
document.getElementById('cancel-sel-btn').addEventListener('click',()=>{selectedTasks.clear();updateBulkActions();renderKanban();});
document.getElementById('modal-close').addEventListener('click',closeTaskModal);
document.getElementById('modal-delete').addEventListener('click',deleteTaskFromModal);
document.getElementById('modal-board-select')?.addEventListener('change', e => {
  const colSel = document.getElementById('modal-col-select');
  const currentCol = colSel?.value;
  populateColSelectForBoard(e.target.value, currentCol);
});
document.getElementById('task-modal').addEventListener('click',e=>{if(e.target===document.getElementById('task-modal'))closeTaskModal();});

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
