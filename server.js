'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const net = require('net');
const { advance, computeInitialNextFire } = require('./recurrence');
// web-push is in package.json (Docker installs it); tolerate a local checkout
// without node_modules so the server still boots for dev/testing.
let webpush = null;
try { webpush = require('web-push'); } catch (e) {}
// twilio powers the Calls tab (browser dialer) — same tolerance as web-push.
let twilio = null;
try { twilio = require('twilio'); } catch (e) {}
const { renderAuditHtml } = require('./audit_render');
const { Readable } = require('stream');
const app = express();
const PORT = parseInt(process.env.PORT || '4000');
const DB_PATH = process.env.DB_PATH || '/data/workspace.db';

// Map of pin -> userId. AUTH_USERS="alice:1234,bob:5678" (example) or falls back to single-user.
// Fail closed: refuse to start with no PIN configured rather than accept a baked-in default.
const USERS = (() => {
  if (process.env.AUTH_USERS) {
    return Object.fromEntries(
      process.env.AUTH_USERS.split(',').map(entry => {
        const [id, pin] = entry.trim().split(':');
        return [pin, id];
      })
    );
  }
  if (process.env.AUTH_PASSWORD) return { [process.env.AUTH_PASSWORD]: 'owner' };
  return {};
})();
// Null prototype so a PIN of "__proto__"/"constructor"/"toString" can't look up an
// inherited Object member and pass as a valid user.
Object.setPrototypeOf(USERS, null);
if (!Object.keys(USERS).length) {
  console.error('FATAL: no auth configured. Set AUTH_USERS ("user:pin,user:pin") or AUTH_PASSWORD.');
  process.exit(1);
}

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const UPLOADS_DIR = path.join(dataDir, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Only real image types get saved — the extension comes from this map, never from
// the client's claimed mimetype, so nobody can upload an HTML/SVG file that our
// own domain would then serve back as a runnable page.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      cb(null, crypto.randomBytes(12).toString('hex') + '.' + IMAGE_EXT[file.mimetype]);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT[file.mimetype]) return cb(null, true);
    req.badFileType = true;
    cb(null, false);
  },
  limits: { fileSize: 25 * 1024 * 1024 }
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);


// ── Safe migrations (add-only) ─────────────────────────────────
try { db.exec(`ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE notes ADD COLUMN deleted_at INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN deleted_at INTEGER DEFAULT NULL`); } catch(e) {}
// Multi-user: scope all data by user_id (existing rows default to 'owner')
try { db.exec(`ALTER TABLE notes   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE boards  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE columns ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
// Claude mark: flags a task as greenlit for Claude Code to work on (read via direct DB query)
try { db.exec(`ALTER TABLE tasks ADD COLUMN claude_marked INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
// Initialize note positions (newest first) when all are at the default 0
{
  const stats = db.prepare('SELECT COUNT(*) AS total, MAX(position) AS maxPos FROM notes').get();
  if (stats.total > 1 && stats.maxPos === 0) {
    const rows = db.prepare('SELECT id FROM notes ORDER BY updated_at DESC').all();
    const upd = db.prepare('UPDATE notes SET position=? WHERE id=?');
    db.transaction(() => rows.forEach((r, i) => upd.run(i, r.id)))();
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    payee TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expense_categories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
`);
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_cat_name ON expense_categories(user_id, name)`); } catch(e) {}
try { db.exec(`ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE expenses ADD COLUMN frequency TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE expenses ADD COLUMN direction TEXT NOT NULL DEFAULT 'withdrawal'`); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    first_fire_at INTEGER NOT NULL,
    recur_type TEXT NOT NULL DEFAULT 'none',
    recur_interval INTEGER NOT NULL DEFAULT 1,
    recur_weekdays TEXT DEFAULT NULL,
    recur_end_at INTEGER DEFAULT NULL,
    next_fire_at INTEGER DEFAULT NULL,
    snoozed_until INTEGER DEFAULT NULL,
    completed_at INTEGER DEFAULT NULL,
    deleted_at INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_next ON reminders(next_fire_at);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// Lead-time alerts: fire once at next_fire_at - lead_minutes, plus the normal
// at-time alert. lead_fired_for remembers WHICH occurrence the lead was sent
// for — it re-arms automatically when next_fire_at advances.
try { db.exec(`ALTER TABLE reminders ADD COLUMN lead_minutes INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE reminders ADD COLUMN lead_fired_for INTEGER DEFAULT NULL`); } catch(e) {}

// Calls tab: one row per outbound call, written by the Twilio webhooks below.
// Recordings stay on Twilio's storage — recording_sid is the pointer, audio is
// proxied through /api/twilio/recording/:sid on demand.
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    call_sid TEXT UNIQUE,
    to_number TEXT NOT NULL DEFAULT '',
    from_number TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'initiated',
    duration INTEGER DEFAULT NULL,
    recording_sid TEXT DEFAULT NULL,
    recording_duration INTEGER DEFAULT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at);
`);

// Audits tab: one JSON blob per audit (identity, current_situation, findings
// with sources, heatmaps, gsc, narrative — same shape as AUTOMATED_AUDITS'
// input_template.json), matching how notes.content already stores a blob
// rather than a relational split.
db.exec(`
  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    business_name TEXT NOT NULL DEFAULT 'Untitled audit',
    status TEXT NOT NULL DEFAULT 'draft',
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audits_user ON audits(user_id, updated_at);
`);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks POST form-encoded
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ─────────────────────────────────────────────────────
// Rate limit: after 10 failed PIN attempts an IP is locked out for 5 minutes,
// so a 4-digit PIN can't just be brute-forced by a script.
// ponytail: in-memory per-IP counter — resets on restart, plenty for a family app.
const FAILS = new Map(); // ip -> { count, until }
const MAX_FAILS = 10, LOCK_MS = 5 * 60 * 1000;
// Cloudflare's published edge ranges — https://www.cloudflare.com/ips-v4 and /ips-v6
// (fetched 2026-07-24). Only used to decide whether CF-Connecting-IP is trustworthy;
// refresh if Cloudflare ever publishes new ranges (they change rarely).
const CF_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const CF_BLOCKLIST = new net.BlockList();
for (const cidr of CF_RANGES) {
  const [addr, prefix] = cidr.split('/');
  CF_BLOCKLIST.addSubnet(addr, parseInt(prefix), addr.includes(':') ? 'ipv6' : 'ipv4');
}
function isCloudflare(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '');
  const v = net.isIP(clean);
  return v === 4 ? CF_BLOCKLIST.check(clean, 'ipv4')
       : v === 6 ? CF_BLOCKLIST.check(clean, 'ipv6') : false;
}

// The identity used for login lockout, so one attacker can't be counted as many people.
// Request chain is: real client -> Cloudflare -> Caddy (loopback) -> here. Node's own
// socket peer is always Caddy, so the address to vet is the LAST X-Forwarded-For entry —
// that one is appended by Caddy and is the TCP peer Caddy actually saw. Only if that hop
// is a published Cloudflare edge IP do we believe CF-Connecting-IP; otherwise we fall back
// to the raw socket/hop address. X-Forwarded-For's client-supplied entries are never
// trusted — anyone can send a fresh fake one on every guess and never get locked out.
function isLoopback(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '');
  return clean === '::1' || clean.startsWith('127.');
}
function clientIp(req) {
  // X-Forwarded-For is only worth reading at all if the connection came from our own
  // reverse proxy on loopback. A direct hit on the app port gets judged by its socket
  // address, headers ignored.
  const sock = req.socket.remoteAddress;
  if (!isLoopback(sock)) return sock || '?';
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const peer = hops.length ? hops[hops.length - 1] : sock;
  if (isCloudflare(peer)) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
  }
  return peer || req.socket.remoteAddress || '?';
}
function lockedOut(ip) {
  const f = FAILS.get(ip);
  return !!(f && f.until > Date.now());
}
function recordFail(ip) {
  if (FAILS.size > 1000) for (const [k, v] of FAILS) { if (v.until < Date.now()) FAILS.delete(k); }
  const f = FAILS.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  FAILS.set(ip, f);
}

// "Basic base64(user:pin)" -> userId, or null. The username part is ignored; the PIN identifies the user.
function userFromBasic(value) {
  if (!value || !value.startsWith('Basic ')) return null;
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return USERS[pass] || null;
}

function checkAuth(req, res, next, credential) {
  const ip = clientIp(req);
  if (lockedOut(ip)) return res.status(429).json({ error: 'Too many failed attempts — try again in a few minutes' });
  const userId = userFromBasic(credential);
  if (!userId) {
    if (credential) recordFail(ip); // only count actual wrong guesses, not missing headers
    res.set('WWW-Authenticate', 'Basic realm="Workspace"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  FAILS.delete(ip);
  req.userId = userId;
  next();
}

function auth(req, res, next) {
  checkAuth(req, res, next, req.headers.authorization || '');
}

// Uploaded images load via plain <img> tags, which can't send the Authorization
// header — so the app also stores the same credential in a cookie scoped to
// /uploads, and this middleware accepts either. Outsiders get a 401 either way.
function uploadsAuth(req, res, next) {
  let credential = req.headers.authorization || '';
  if (!credential) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)ws_auth=([^;]+)/);
    if (m) credential = decodeURIComponent(m[1]);
  }
  checkAuth(req, res, next, credential);
}

app.use('/uploads', uploadsAuth, express.static(UPLOADS_DIR));

function uid() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

// ── Rate limit ───────────────────────────────────────────────
// ponytail: fixed-window per-IP counter, same in-memory shape as the login lockout above —
// no extra dependency. Ceiling is deliberately generous: the app polls /api/sync every 2s
// (~30 req/min per open tab), so 300/min leaves room for ~10 tabs plus bursts. Per-process
// and resets on restart; swap in express-rate-limit only if this ever runs multi-instance.
const RATE = new Map(); // ip -> { count, start }
const RATE_MAX = 300, RATE_WINDOW_MS = 60 * 1000;
app.use('/api', (req, res, next) => {
  const ip = clientIp(req);
  const t = Date.now();
  let r = RATE.get(ip);
  if (!r || t - r.start > RATE_WINDOW_MS) { r = { count: 0, start: t }; RATE.set(ip, r); }
  if (RATE.size > 5000) for (const [k, v] of RATE) { if (t - v.start > RATE_WINDOW_MS) RATE.delete(k); }
  if (++r.count > RATE_MAX) {
    res.set('Retry-After', String(Math.ceil((r.start + RATE_WINDOW_MS - t) / 1000)));
    return res.status(429).json({ error: 'Rate limit exceeded — slow down' });
  }
  next();
});

// ── Auth check ──────────────────────────────────────────────
app.get('/api/auth/check', auth, (req, res) => res.json({ ok: true }));

// ── Audits ───────────────────────────────────────────────────
app.get('/api/audits', auth, (req, res) => {
  const rows = db.prepare('SELECT id, business_name, status, data, updated_at FROM audits WHERE deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows.map(r => {
    let report_type = 'seo';
    try { report_type = JSON.parse(r.data).report_type || 'seo'; } catch {}
    return { id: r.id, business_name: r.business_name, status: r.status, report_type, updated_at: r.updated_at };
  }));
});

app.get('/api/audits/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM audits WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ ...a, data: JSON.parse(a.data) });
});

app.post('/api/audits', auth, (req, res) => {
  const { business_name = 'Untitled audit', data = {} } = req.body;
  const id = uid(), t = now();
  db.prepare('INSERT INTO audits (id, business_name, status, data, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, business_name, 'draft', JSON.stringify(data), req.userId, t, t);
  res.json({ id, business_name, status: 'draft', data, created_at: t, updated_at: t });
});

app.put('/api/audits/:id', auth, (req, res) => {
  const { business_name, status, data } = req.body;
  const t = now();
  const a = db.prepare('SELECT * FROM audits WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE audits SET business_name=?, status=?, data=?, updated_at=? WHERE id=? AND user_id=?')
    .run(business_name ?? a.business_name, status ?? a.status, JSON.stringify(data ?? JSON.parse(a.data)), t, req.params.id, req.userId);
  const updated = db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
  res.json({ ...updated, data: JSON.parse(updated.data) });
});

app.delete('/api/audits/:id', auth, (req, res) => {
  db.prepare('UPDATE audits SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// Stateless render — used for the live preview + the printable/exportable
// document. Takes data straight from the request so unsaved edits preview
// immediately, no round trip through the DB.
app.post('/api/audits/render', auth, (req, res) => {
  try {
    res.type('html').send(renderAuditHtml(req.body.data || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Notes ────────────────────────────────────────────────────
app.get('/api/notes', auth, (req, res) => {
  res.json(db.prepare('SELECT id, title, updated_at, position FROM notes WHERE deleted_at IS NULL AND user_id=? ORDER BY position ASC').all(req.userId));
});

app.get('/api/notes/:id', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.json(note);
});

app.post('/api/notes', auth, (req, res) => {
  const { title = 'Untitled', content = '' } = req.body;
  const id = uid(), t = now();
  db.prepare('UPDATE notes SET position = position + 1 WHERE user_id=? AND deleted_at IS NULL').run(req.userId);
  db.prepare('INSERT INTO notes (id, title, content, user_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(id, title, content, req.userId, t, t);
  res.json({ id, title, content, position: 0, created_at: t, updated_at: t });
});

app.put('/api/notes/:id', auth, (req, res) => {
  const { title, content, tags, position } = req.body;
  const t = now();
  const n = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!n) return res.status(404).json({ error: 'Not found' });
  if (position !== undefined && title === undefined && content === undefined && tags === undefined) {
    db.prepare('UPDATE notes SET position=? WHERE id=? AND user_id=?').run(position, req.params.id, req.userId);
  } else {
    db.prepare('UPDATE notes SET title=?, content=?, tags=?, updated_at=? WHERE id=? AND user_id=?')
      .run(title ?? n.title, content ?? n.content, tags ?? n.tags ?? '', t, req.params.id, req.userId);
  }
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id));
});

// Soft-delete note (moves to trash)
app.delete('/api/notes/:id', auth, (req, res) => {
  db.prepare('UPDATE notes SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// Import .md files — body: { files: [{ name, content }] }
app.post('/api/notes/import', auth, (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files array required' });
  const ins = db.prepare('INSERT INTO notes (id, title, content, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const t = now();
  const imported = [];
  const run = db.transaction(() => {
    for (const f of files) {
      const id = uid();
      const title = (f.name || 'Untitled').replace(/\.md$/i, '');
      ins.run(id, title, f.content || '', req.userId, t, t);
      imported.push({ id, title });
    }
  });
  run();
  res.json({ imported: imported.length, notes: imported });
});

// Full sync snapshot
app.get('/api/sync', auth, (req, res) => {
  const notes = db.prepare('SELECT * FROM notes WHERE deleted_at IS NULL AND user_id=? ORDER BY position ASC').all(req.userId);
  const boards = db.prepare('SELECT * FROM boards WHERE user_id=? ORDER BY position').all(req.userId);
  const columns = db.prepare('SELECT * FROM columns WHERE user_id=? ORDER BY position').all(req.userId);
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL AND user_id=? ORDER BY position').all(req.userId);
  const reminders = db.prepare('SELECT * FROM reminders WHERE deleted_at IS NULL AND user_id=? AND (completed_at IS NULL OR completed_at > ?) ORDER BY next_fire_at ASC')
    .all(req.userId, now() - COMPLETED_KEEP_MS);
  // Newest 200 calls only — this rides the 2s poll, keep the payload bounded.
  const calls = db.prepare('SELECT * FROM calls WHERE user_id=? ORDER BY started_at DESC LIMIT 200').all(req.userId);
  res.json({ notes, boards, columns, tasks, reminders, calls });
});

// ── Boards ────────────────────────────────────────────────────
app.get('/api/boards', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM boards WHERE user_id=? ORDER BY position, created_at').all(req.userId));
});

app.post('/api/boards', auth, (req, res) => {
  const { name, columns: cols } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid(), t = now();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM boards WHERE user_id=?').get(req.userId).m;
  db.prepare('INSERT INTO boards (id, name, position, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, maxPos + 1, req.userId, t);
  if (Array.isArray(cols)) {
    const ins = db.prepare('INSERT INTO columns (id, board_id, name, position, user_id) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => cols.forEach((c, i) => ins.run(uid(), id, c, i, req.userId)))();
  }
  res.json(db.prepare('SELECT * FROM boards WHERE id = ?').get(id));
});

app.put('/api/boards/:id', auth, (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!board) return res.status(404).json({ error: 'Not found' });
  const { name = board.name, position = board.position } = req.body;
  db.prepare('UPDATE boards SET name=?, position=? WHERE id=? AND user_id=?').run(name, position, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id));
});

app.delete('/api/boards/:id', auth, (req, res) => {
  db.prepare('DELETE FROM boards WHERE id = ? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Columns ───────────────────────────────────────────────────
app.get('/api/boards/:boardId/columns', auth, (req, res) => {
  const cols = db.prepare('SELECT * FROM columns WHERE board_id=? AND user_id=? ORDER BY position').all(req.params.boardId, req.userId);
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE deleted_at IS NULL AND user_id=? AND column_id IN (SELECT id FROM columns WHERE board_id=?) ORDER BY position'
  ).all(req.userId, req.params.boardId);
  res.json(cols.map(c => ({ ...c, tasks: tasks.filter(t => t.column_id === c.id) })));
});

app.post('/api/columns', auth, (req, res) => {
  const { board_id, name } = req.body;
  if (!board_id || !name) return res.status(400).json({ error: 'board_id and name required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM columns WHERE board_id=? AND user_id=?').get(board_id, req.userId).m;
  const id = uid();
  db.prepare('INSERT INTO columns (id, board_id, name, position, user_id) VALUES (?, ?, ?, ?, ?)').run(id, board_id, name, maxPos + 1, req.userId);
  res.json(db.prepare('SELECT * FROM columns WHERE id = ?').get(id));
});

app.put('/api/columns/:id', auth, (req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!col) return res.status(404).json({ error: 'Not found' });
  const { name = col.name, position = col.position } = req.body;
  db.prepare('UPDATE columns SET name=?, position=? WHERE id=? AND user_id=?').run(name, position, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM columns WHERE id=?').get(req.params.id));
});

app.delete('/api/columns/:id', auth, (req, res) => {
  db.prepare('DELETE FROM columns WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Tasks ─────────────────────────────────────────────────────
app.post('/api/tasks', auth, (req, res) => {
  const { column_id, title, description = '', claude_marked = 0, tags = '' } = req.body;
  if (!column_id || !title) return res.status(400).json({ error: 'column_id and title required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM tasks WHERE column_id=? AND user_id=? AND deleted_at IS NULL').get(column_id, req.userId).m;
  const id = uid(), t = now();
  db.prepare('INSERT INTO tasks (id, column_id, title, description, position, claude_marked, tags, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, column_id, title, description, maxPos + 1, claude_marked ? 1 : 0, tags, req.userId, t, t);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const {
    title = task.title, description = task.description,
    column_id = task.column_id, position = task.position,
    claude_marked = task.claude_marked, tags = task.tags
  } = req.body;
  db.prepare('UPDATE tasks SET title=?, description=?, column_id=?, position=?, claude_marked=?, tags=?, updated_at=? WHERE id=? AND user_id=?')
    .run(title, description, column_id, position, claude_marked ? 1 : 0, tags, now(), req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id));
});

// Bulk soft-delete
app.delete('/api/tasks', auth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const del = db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?');
  const t = now();
  db.transaction(() => ids.forEach(id => del.run(t, id, req.userId)))();
  res.json({ deleted: ids.length });
});

// Soft-delete single task
app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Trash ─────────────────────────────────────────────────────
app.get('/api/trash', auth, (req, res) => {
  const notes = db.prepare('SELECT id, title, deleted_at FROM notes WHERE deleted_at IS NOT NULL AND user_id=? ORDER BY deleted_at DESC').all(req.userId);
  const tasks = db.prepare('SELECT id, title, column_id, deleted_at FROM tasks WHERE deleted_at IS NOT NULL AND user_id=? ORDER BY deleted_at DESC').all(req.userId);
  const reminders = db.prepare('SELECT id, title, deleted_at FROM reminders WHERE deleted_at IS NOT NULL AND user_id=? ORDER BY deleted_at DESC').all(req.userId);
  res.json({ notes, tasks, reminders });
});

app.post('/api/trash/restore', auth, (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  if (type === 'note') db.prepare('UPDATE notes SET deleted_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'task') db.prepare('UPDATE tasks SET deleted_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'reminder') db.prepare('UPDATE reminders SET deleted_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else return res.status(400).json({ error: 'type must be note, task, or reminder' });
  res.json({ ok: true });
});

// ── Image uploads ─────────────────────────────────────────────
app.post('/api/uploads', auth, upload.single('image'), (req, res) => {
  if (req.badFileType) return res.status(400).json({ error: 'Only PNG, JPEG, GIF, or WebP images are allowed' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

function extractUploadFilenames(content) {
  const names = [];
  for (const m of (content || '').matchAll(/!\[[^\]]*\]\(\/uploads\/([^)]+)\)/g))
    names.push(m[1]);
  return names;
}

function deleteUploadFiles(filenames) {
  for (const name of filenames) {
    // basename() strips any directory part, so a note body with
    // ![x](/uploads/../../etc/something) can only ever delete inside UPLOADS_DIR.
    try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(name))); } catch(e) {}
  }
}

app.delete('/api/trash/item', auth, (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  if (type === 'note') {
    const row = db.prepare('SELECT content FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL').get(id, req.userId);
    if (row) deleteUploadFiles(extractUploadFilenames(row.content));
    db.prepare('DELETE FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL').run(id, req.userId);
  } else if (type === 'task') {
    const row = db.prepare('SELECT description FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NOT NULL').get(id, req.userId);
    if (row) deleteUploadFiles(extractUploadFilenames(row.description));
    db.prepare('DELETE FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NOT NULL').run(id, req.userId);
  } else if (type === 'reminder') {
    db.prepare('DELETE FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NOT NULL').run(id, req.userId);
  }
  res.json({ ok: true });
});

app.delete('/api/trash/empty', auth, (req, res) => {
  const notes = db.prepare('SELECT content FROM notes WHERE deleted_at IS NOT NULL AND user_id=?').all(req.userId);
  const tasks = db.prepare('SELECT description FROM tasks WHERE deleted_at IS NOT NULL AND user_id=?').all(req.userId);
  notes.forEach(r => deleteUploadFiles(extractUploadFilenames(r.content)));
  tasks.forEach(r => deleteUploadFiles(extractUploadFilenames(r.description)));
  db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND user_id=?').run(req.userId);
  db.prepare('DELETE FROM tasks WHERE deleted_at IS NOT NULL AND user_id=?').run(req.userId);
  db.prepare('DELETE FROM reminders WHERE deleted_at IS NOT NULL AND user_id=?').run(req.userId);
  res.json({ ok: true });
});


// ── Expenses ──────────────────────────────────────────────────
app.get('/api/expenses', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, created_at DESC').all(req.userId));
});

app.post('/api/expenses', auth, (req, res) => {
  const { amount, date, category = '', payee = '', note = '', source = '', frequency = '', direction = 'withdrawal' } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const id = uid(), t = now();
  db.prepare('INSERT INTO expenses (id, user_id, amount, date, category, payee, note, source, frequency, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, parseFloat(amount), date, category, payee, note, source, frequency, direction, t);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
});

app.put('/api/expenses/:id', auth, (req, res) => {
  const exp = db.prepare('SELECT * FROM expenses WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!exp) return res.status(404).json({ error: 'Not found' });
  const { amount = exp.amount, date = exp.date, category = exp.category, payee = exp.payee, note = exp.note, source = exp.source, frequency = exp.frequency, direction = exp.direction } = req.body;
  db.prepare('UPDATE expenses SET amount=?, date=?, category=?, payee=?, note=?, source=?, frequency=?, direction=? WHERE id=? AND user_id=?')
    .run(parseFloat(amount), date, category, payee, note, source, frequency, direction, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
});

app.delete('/api/expenses/:id', auth, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

app.get('/api/expense-categories', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM expense_categories WHERE user_id=? ORDER BY position, name').all(req.userId));
});

app.post('/api/expense-categories', auth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const existing = db.prepare('SELECT * FROM expense_categories WHERE user_id=? AND name=?').get(req.userId, name.trim());
  if (existing) return res.json(existing);
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM expense_categories WHERE user_id=?').get(req.userId).m;
  const id = uid();
  db.prepare('INSERT INTO expense_categories (id, user_id, name, position) VALUES (?, ?, ?, ?)').run(id, req.userId, name.trim(), maxPos + 1);
  res.json(db.prepare('SELECT * FROM expense_categories WHERE id=?').get(id));
});

app.delete('/api/expense-categories/:name', auth, (req, res) => {
  db.prepare('DELETE FROM expense_categories WHERE user_id=? AND name=?').run(req.userId, decodeURIComponent(req.params.name));
  res.json({ ok: true });
});

app.get('/api/expenses/export.csv', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, created_at DESC').all(req.userId);
  const csvField = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['date,amount,category,payee,source,frequency,direction,note'];
  for (const r of rows) lines.push([r.date, r.amount, r.category, r.payee, r.source, r.frequency, r.direction, r.note].map(csvField).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="expenses.csv"');
  res.send(lines.join('\n'));
});

app.post('/api/expenses/import', auth, (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });
  const parseCSVLine = line => {
    const fields = []; let current = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; } else inQuotes = !inQuotes;
      } else if (line[i] === ',' && !inQuotes) { fields.push(current); current = ''; }
      else current += line[i];
    }
    fields.push(current); return fields;
  };
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return res.json({ imported: 0 });
  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const [dateIdx, amountIdx, categoryIdx, payeeIdx, sourceIdx, frequencyIdx, directionIdx, noteIdx] =
    ['date','amount','category','payee','source','frequency','direction','note'].map(k => header.indexOf(k));
  if (dateIdx < 0 || amountIdx < 0) return res.status(400).json({ error: 'CSV must have date and amount columns' });
  const ins = db.prepare('INSERT INTO expenses (id, user_id, amount, date, category, payee, note, source, frequency, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const t = now(); let imported = 0;
  db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const f = parseCSVLine(lines[i]);
      const date = f[dateIdx]?.trim(), amount = parseFloat(f[amountIdx]);
      if (!date || isNaN(amount)) continue;
      ins.run(uid(), req.userId, amount, date,
        categoryIdx >= 0 ? (f[categoryIdx]?.trim() || '') : '',
        payeeIdx    >= 0 ? (f[payeeIdx]?.trim()    || '') : '',
        noteIdx     >= 0 ? (f[noteIdx]?.trim()     || '') : '',
        sourceIdx     >= 0 ? (f[sourceIdx]?.trim()     || '') : '',
        frequencyIdx  >= 0 ? (f[frequencyIdx]?.trim()  || '') : '',
        directionIdx  >= 0 ? (f[directionIdx]?.trim()  || 'withdrawal') : 'withdrawal',
        t);
      imported++;
    }
  })();
  res.json({ imported });
});

// ── Reminders (Calendar tab) ──────────────────────────────────
const RECUR_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

// Validates + normalizes reminder schedule fields from a request body.
// Returns { error } or the clean fields.
function reminderFields(body) {
  const title = String(body.title ?? '').trim();
  if (!title) return { error: 'title required' };
  const first_fire_at = Number(body.first_fire_at);
  if (!Number.isFinite(first_fire_at)) return { error: 'first_fire_at (epoch ms) required' };
  const recur_type = body.recur_type ?? 'none';
  if (!RECUR_TYPES.includes(recur_type)) return { error: 'invalid recur_type' };
  const recur_interval = Math.max(1, parseInt(body.recur_interval, 10) || 1);
  let recur_weekdays = null;
  if (body.recur_weekdays != null && body.recur_weekdays !== '') {
    const days = String(body.recur_weekdays).split(',').map(s => parseInt(s.trim(), 10));
    if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'recur_weekdays must be 0-6' };
    recur_weekdays = [...new Set(days)].sort().join(',');
  }
  let recur_end_at = null;
  if (body.recur_end_at != null) {
    recur_end_at = Number(body.recur_end_at);
    if (!Number.isFinite(recur_end_at)) return { error: 'recur_end_at must be epoch ms' };
  }
  let lead_minutes = null;
  if (body.lead_minutes != null && body.lead_minutes !== '') {
    lead_minutes = Number(body.lead_minutes);
    if (!Number.isInteger(lead_minutes) || lead_minutes < 1) return { error: 'lead_minutes must be a positive integer' };
  }
  return {
    title, description: String(body.description ?? ''),
    first_fire_at, recur_type, recur_interval, recur_weekdays, recur_end_at, lead_minutes,
  };
}

// Completed one-offs stay listed for 60 days (the agenda's Completed section),
// then drop out of the payload — keeps the 2s sync poll from growing forever.
const COMPLETED_KEEP_MS = 60 * 86400000;

app.get('/api/reminders', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM reminders WHERE user_id=? AND deleted_at IS NULL AND (completed_at IS NULL OR completed_at > ?) ORDER BY next_fire_at ASC')
    .all(req.userId, now() - COMPLETED_KEEP_MS));
});

app.post('/api/reminders', auth, (req, res) => {
  const f = reminderFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const id = uid(), t = now();
  const next_fire_at = computeInitialNextFire(f, t);
  if (f.recur_type !== 'none' && next_fire_at === null)
    return res.status(400).json({ error: 'series is entirely in the past — check the end date' });
  db.prepare(`INSERT INTO reminders (id, user_id, title, description, first_fire_at, recur_type, recur_interval,
      recur_weekdays, recur_end_at, lead_minutes, next_fire_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.userId, f.title, f.description, f.first_fire_at, f.recur_type, f.recur_interval,
      f.recur_weekdays, f.recur_end_at, f.lead_minutes, next_fire_at, t, t);
  res.json(db.prepare('SELECT * FROM reminders WHERE id=?').get(id));
});

app.put('/api/reminders/:id', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const f = reminderFields({ ...r, ...req.body });
  if (f.error) return res.status(400).json({ error: f.error });
  const scheduleChanged =
    f.first_fire_at !== r.first_fire_at || f.recur_type !== r.recur_type ||
    f.recur_interval !== r.recur_interval || f.recur_weekdays !== r.recur_weekdays ||
    f.recur_end_at !== r.recur_end_at;
  const t = now();
  // A schedule edit re-arms the reminder: recompute next fire, clear snooze,
  // and un-complete (rescheduling an old done one-off is the natural "revive").
  const next_fire_at = scheduleChanged ? computeInitialNextFire(f, t) : r.next_fire_at;
  if (scheduleChanged && f.recur_type !== 'none' && next_fire_at === null)
    return res.status(400).json({ error: 'series is entirely in the past — check the end date' });
  const snoozed_until = scheduleChanged ? null : r.snoozed_until;
  const completed_at = scheduleChanged ? null : r.completed_at;
  db.prepare(`UPDATE reminders SET title=?, description=?, first_fire_at=?, recur_type=?, recur_interval=?,
      recur_weekdays=?, recur_end_at=?, lead_minutes=?, next_fire_at=?, snoozed_until=?, completed_at=?, updated_at=?
    WHERE id=? AND user_id=?`)
    .run(f.title, f.description, f.first_fire_at, f.recur_type, f.recur_interval,
      f.recur_weekdays, f.recur_end_at, f.lead_minutes, next_fire_at, snoozed_until, completed_at, t, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id));
});

// Registered BEFORE /api/reminders/:id so the literal path isn't swallowed
// by the :id pattern (same route-ordering lesson as expenses export.csv).
app.delete('/api/reminders/completed', auth, (req, res) => {
  const info = db.prepare('UPDATE reminders SET deleted_at=? WHERE user_id=? AND completed_at IS NOT NULL AND deleted_at IS NULL')
    .run(now(), req.userId);
  res.json({ deleted: info.changes });
});

app.delete('/api/reminders/:id', auth, (req, res) => {
  db.prepare('UPDATE reminders SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/reminders/:id/complete', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  // One-off, or a recurring series already exhausted past its end date: done for good.
  if (r.recur_type === 'none' || r.next_fire_at === null) {
    db.prepare('UPDATE reminders SET completed_at=?, snoozed_until=NULL, next_fire_at=NULL, updated_at=? WHERE id=?').run(now(), now(), r.id);
  } else {
    // Recurring with a live series: completing early advances past the current
    // occurrence right now (same math the scheduler uses at fire time), so the
    // agenda immediately shows the next one instead of waiting for the clock.
    const next = advance(r, r.next_fire_at);
    if (next === null) {
      db.prepare('UPDATE reminders SET next_fire_at=NULL, completed_at=?, snoozed_until=NULL, updated_at=? WHERE id=?').run(now(), now(), r.id);
    } else {
      db.prepare('UPDATE reminders SET next_fire_at=?, snoozed_until=NULL, updated_at=? WHERE id=?').run(next, now(), r.id);
    }
  }
  res.json(db.prepare('SELECT * FROM reminders WHERE id=?').get(r.id));
});

app.post('/api/reminders/:id/snooze', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.completed_at) return res.status(400).json({ error: 'reminder is completed' });
  const minutes = parseInt(req.body.minutes, 10);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) return res.status(400).json({ error: 'minutes must be 1-10080' });
  db.prepare('UPDATE reminders SET snoozed_until=?, updated_at=? WHERE id=?').run(now() + minutes * 60000, now(), r.id);
  res.json(db.prepare('SELECT * FROM reminders WHERE id=?').get(r.id));
});

// ── Twilio dialer (Calls tab) ─────────────────────────────────
// All six env vars live in the server's docker-compose.yml, same as the VAPID
// keys — never committed. Without them the app runs; the Calls tab just shows
// "not configured" instead of a dial pad.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || '';
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || '';
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID || '';
const TWILIO_CALLER_ID = process.env.TWILIO_CALLER_ID || '';
const twilioEnabled = !!(twilio && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_API_KEY_SID
  && TWILIO_API_KEY_SECRET && TWILIO_TWIML_APP_SID && TWILIO_CALLER_ID);
if (!twilioEnabled) console.warn('twilio disabled — twilio module or TWILIO_* env vars not configured');

// The webhook routes are public URLs Twilio's servers call directly — they
// can't hold a PIN, so they're NOT behind auth. Instead every request must
// carry a valid X-Twilio-Signature (HMAC over the exact URL + params, keyed
// by the auth token) or it's rejected. Random scanners get a 403.
function twilioWebhook(req, res, next) {
  if (!twilioEnabled) return res.status(503).send('twilio not configured');
  const signature = req.headers['x-twilio-signature'] || '';
  const url = 'https://' + req.get('host') + req.originalUrl;
  if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {}))
    return res.status(403).send('invalid signature');
  next();
}

// Short-lived token the browser SDK uses to place calls. Identity = the
// logged-in user; the VoiceGrant points at the TwiML App whose Voice URL is
// /api/twilio/voice below. Outbound-only by design (incomingAllow false).
app.get('/api/twilio/token', auth, (req, res) => {
  if (!twilioEnabled) return res.status(503).json({ error: 'twilio not configured' });
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET,
    { identity: req.userId, ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: false }));
  res.json({ token: token.toJwt(), identity: req.userId, callerId: TWILIO_CALLER_ID });
});

// Accepts what a human types, returns E.164 or null. US-default like the UI.
function normalizeE164(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
  if (/^1\d{10}$/.test(d)) return '+' + d;
  if (/^[2-9]\d{9}$/.test(d)) return '+1' + d;
  return null;
}

// Twilio fetches this when the browser SDK connects. From is "client:<user>",
// To is the param the dial pad passed. Responds with TwiML that dials out with
// the real caller ID and records both sides on separate tracks from answer.
app.post('/api/twilio/voice', twilioWebhook, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const from = String(req.body.From || '');
  const userId = from.startsWith('client:') ? from.slice(7) : '';
  const to = normalizeE164(req.body.To);
  // Only the browser SDK (From=client:<known user>) may trigger a dial — a
  // signed request from any other Twilio path (e.g. someone calling the
  // number inbound if it ever gets pointed here) must not place calls.
  if (!userId || !Object.values(USERS).includes(userId)) {
    twiml.reject();
  } else if (!to) {
    twiml.say('Invalid number.');
  } else {
    db.prepare(`INSERT OR IGNORE INTO calls (id, user_id, call_sid, to_number, from_number, status, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'initiated', ?, ?)`)
      .run(uid(), userId, req.body.CallSid || null, to, TWILIO_CALLER_ID, now(), now());
    const dial = twiml.dial({
      callerId: TWILIO_CALLER_ID,
      answerOnBridge: true,                        // browser leg stays "ringing" until the callee answers
      record: 'record-from-answer-dual',           // two clean tracks: you / them
      recordingStatusCallback: '/api/twilio/recording-status',
      recordingStatusCallbackEvent: 'completed',
      action: '/api/twilio/dial-status',           // relative URLs resolve against this webhook's URL
    });
    dial.number(to);
  }
  res.type('text/xml').send(twiml.toString());
});

// Fires when the <Dial> finishes — the accurate outcome (completed / busy /
// no-answer / failed / canceled) plus talk time. Empty TwiML ends the call.
app.post('/api/twilio/dial-status', twilioWebhook, (req, res) => {
  const { CallSid, DialCallStatus, DialCallDuration } = req.body;
  if (CallSid && DialCallStatus) {
    db.prepare('UPDATE calls SET status=?, duration=?, ended_at=? WHERE call_sid=?')
      .run(DialCallStatus, parseInt(DialCallDuration, 10) || 0, now(), CallSid);
  }
  res.type('text/xml').send(new twilio.twiml.VoiceResponse().toString());
});

// Recording finished processing on Twilio's side. Also tolerates plain
// call-status events (the TwiML App's StatusCallback points here too) without
// clobbering the more precise outcome dial-status already wrote.
app.post('/api/twilio/recording-status', twilioWebhook, (req, res) => {
  const { CallSid, RecordingSid, RecordingDuration, CallStatus } = req.body;
  if (CallSid && RecordingSid) {
    db.prepare('UPDATE calls SET recording_sid=?, recording_duration=? WHERE call_sid=?')
      .run(RecordingSid, parseInt(RecordingDuration, 10) || 0, CallSid);
  } else if (CallSid && CallStatus) {
    db.prepare(`UPDATE calls SET status = CASE WHEN status='initiated' THEN ? ELSE status END,
        ended_at = COALESCE(ended_at, ?) WHERE call_sid=?`)
      .run(CallStatus, now(), CallSid);
  }
  res.sendStatus(204);
});

app.get('/api/calls', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM calls WHERE user_id=? ORDER BY started_at DESC LIMIT 200').all(req.userId));
});

// Deletes the call log entry entirely — if it has a recording, that's
// deleted from Twilio's storage first (permanent, frees the cost), then the
// row itself is removed so nothing lingers in the list.
app.delete('/api/calls/:id', auth, async (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!call) return res.status(404).json({ error: 'Not found' });
  if (call.recording_sid) {
    if (!twilioEnabled) return res.status(503).json({ error: 'twilio not configured' });
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${call.recording_sid}.json`, {
        method: 'DELETE',
        headers: { Authorization: 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64') },
      });
      // 404 = already gone on Twilio's side (e.g. deleted from the console) —
      // treat as success rather than blocking the row delete on it.
      if (!r.ok && r.status !== 404) return res.status(502).json({ error: 'Twilio delete failed: ' + r.status });
    } catch (err) {
      console.warn('recording delete failed:', err.message);
      return res.status(502).json({ error: 'could not reach Twilio' });
    }
  }
  db.prepare('DELETE FROM calls WHERE id=?').run(call.id);
  res.json({ ok: true });
});

// Streams the mp3 from Twilio using server-side credentials — the browser
// never sees the auth token and Twilio's URLs are never exposed. The client
// fetches this with its normal Authorization header into a blob for playback.
app.get('/api/twilio/recording/:sid', auth, async (req, res) => {
  if (!twilioEnabled) return res.status(503).json({ error: 'twilio not configured' });
  const sid = req.params.sid;
  if (!/^RE[0-9a-fA-F]{32}$/.test(sid)) return res.status(400).json({ error: 'bad recording id' });
  const owned = db.prepare('SELECT 1 FROM calls WHERE recording_sid=? AND user_id=?').get(sid, req.userId);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`, {
      headers: { Authorization: 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64') },
    });
    if (!r.ok) return res.status(502).json({ error: 'recording fetch failed: ' + r.status });
    res.set('Content-Type', 'audio/mpeg');
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    console.warn('recording proxy failed:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'recording fetch failed' });
  }
});

// Account balance + rough spend, for the Calls tab's "am I burning money"
// glance. 'recordings' is a rollup that duplicates 'calls-recordings' — Twilio
// nests some usage categories under a parent that repeats their cost, so
// summing every category naively double-counts that one. Excluded here.
// ponytail: single-page reads, no pagination — this account has ~50 usage
// categories total, nowhere near Twilio's default page size. Revisit only if
// this account's product mix grows enough to paginate.
const USAGE_ROLLUP_CATEGORIES = new Set(['recordings']);
async function fetchTwilioJson(path) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64') },
  });
  if (!r.ok) throw new Error('Twilio API ' + r.status);
  return r.json();
}
function sumUsageCost(records) {
  return records
    .filter(r => !USAGE_ROLLUP_CATEGORIES.has(r.category))
    .reduce((sum, r) => sum + (parseFloat(r.price) || 0), 0);
}
app.get('/api/twilio/usage', auth, async (req, res) => {
  if (!twilioEnabled) return res.status(503).json({ error: 'twilio not configured' });
  try {
    const [balance, today, month] = await Promise.all([
      fetchTwilioJson('/Balance.json'),
      fetchTwilioJson('/Usage/Records/Today.json?PageSize=200'),
      fetchTwilioJson('/Usage/Records/ThisMonth.json?PageSize=200'),
    ]);
    res.json({
      balance: parseFloat(balance.balance) || 0,
      currency: balance.currency || 'usd',
      spentToday: sumUsageCost(today.usage_records || []),
      spentThisMonth: sumUsageCost(month.usage_records || []),
    });
  } catch (err) {
    console.warn('twilio usage fetch failed:', err.message);
    res.status(502).json({ error: 'could not reach Twilio' });
  }
});

// ── Web push ──────────────────────────────────────────────────
// VAPID keys live in the server's docker-compose.yml env (generate once with
// `npx web-push generate-vapid-keys`) — never committed. Without them the app
// still runs; reminders advance but no notifications go out.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushEnabled = !!(webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails('mailto:workspace@rfisolns.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('push disabled — web-push module or VAPID keys not configured');
}

app.get('/api/push/vapid-key', auth, (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'push not configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !endpoint || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string')
    return res.status(400).json({ error: 'endpoint and keys required' });
  db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(endpoint, req.userId, keys.p256dh, keys.auth, now());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.userId);
  res.json({ ok: true });
});

// ── Reminder scheduler ────────────────────────────────────────
// First in-process background loop in this app: every 15 seconds, fire
// anything due, push to every registered device, then advance recurring
// reminders.
// After downtime a long-overdue reminder fires ONE notification, not a backlog.
async function sendPushToUser(userId, payload) {
  if (!pushEnabled) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        // urgency:high = deliver now, don't batch (matters on Android Doze).
        // TTL 60s: a reminder delivered late is noise, drop it instead.
        { urgency: 'high', TTL: 60 }
      );
    } catch (err) {
      // 404/410 = expired/revoked, 403 = VAPID mismatch (subscribed under old
      // keys) — all permanently dead, retrying can never succeed. Drop them.
      if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 403) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(s.endpoint);
        console.warn('pruned dead push subscription:', err.statusCode, s.endpoint.slice(0, 60));
      } else {
        // Log the body too — status code alone is undiagnosable from docker logs.
        console.warn('push send failed:', err.statusCode || err.message, err.body || '');
      }
    }
  }
}

function humanizeLead(minutes) {
  if (minutes % 1440 === 0) { const d = minutes / 1440; return d + (d === 1 ? ' day' : ' days'); }
  if (minutes % 60 === 0) { const h = minutes / 60; return h + (h === 1 ? ' hour' : ' hours'); }
  return minutes + ' min';
}

function fireTimeLabel(epochMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(epochMs));
}

let schedulerTickRunning = false;
async function checkReminders() {
  if (schedulerTickRunning) return; // a hung push send must not let ticks overlap
  schedulerTickRunning = true;
  try {
    const t = now();
    const due = db.prepare(`SELECT * FROM reminders
      WHERE next_fire_at IS NOT NULL AND next_fire_at <= ? AND completed_at IS NULL AND deleted_at IS NULL`).all(t);
    for (const r of due) {
      // Advance BEFORE the (async) send so a slow push can't double-fire on the next tick.
      if (r.recur_type === 'none') {
        db.prepare('UPDATE reminders SET next_fire_at=NULL WHERE id=?').run(r.id);
      } else {
        let next = r.next_fire_at;
        do { next = advance(r, next); } while (next !== null && next <= t);
        // A null advance means the series just fired its last occurrence
        // (recur_end_at reached) — that's completion, not a dangling row.
        if (next === null) {
          db.prepare('UPDATE reminders SET next_fire_at=NULL, completed_at=? WHERE id=?').run(t, r.id);
        } else {
          db.prepare('UPDATE reminders SET next_fire_at=? WHERE id=?').run(next, r.id);
        }
      }
      await sendPushToUser(r.user_id, { id: r.id, title: r.title, body: r.description || fireTimeLabel(r.next_fire_at) });
    }
    const snoozed = db.prepare(`SELECT * FROM reminders
      WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND completed_at IS NULL AND deleted_at IS NULL`).all(t);
    for (const r of snoozed) {
      db.prepare('UPDATE reminders SET snoozed_until=NULL WHERE id=?').run(r.id);
      await sendPushToUser(r.user_id, { id: r.id, title: r.title, body: '(snoozed) ' + (r.description || '') });
    }
    // Lead-time alerts: fire once per occurrence, lead_minutes before it.
    // Runs AFTER the due pass so an occurrence that just fired (next_fire_at
    // advanced or nulled) can't also send a stale "in 0 min" lead this tick.
    // If the lead point was already past at creation/edit time it fires
    // immediately (deliberate — late beats never). Independent of snooze.
    const leads = db.prepare(`SELECT * FROM reminders
      WHERE lead_minutes IS NOT NULL AND next_fire_at IS NOT NULL
        AND (lead_fired_for IS NULL OR lead_fired_for != next_fire_at)
        AND next_fire_at - (lead_minutes * 60000) <= ?
        AND next_fire_at > ?
        AND completed_at IS NULL AND deleted_at IS NULL`).all(t, t);
    for (const r of leads) {
      // Mark BEFORE the async send — same no-double-fire discipline as due.
      db.prepare('UPDATE reminders SET lead_fired_for=? WHERE id=?').run(r.next_fire_at, r.id);
      await sendPushToUser(r.user_id, {
        id: r.id, title: r.title,
        body: 'in ' + humanizeLead(r.lead_minutes) + (r.description ? ' — ' + r.description : ''),
      });
    }
  } finally {
    schedulerTickRunning = false;
  }
}
setInterval(() => checkReminders().catch(err => console.warn('scheduler tick failed:', err.message)), 15000);
checkReminders().catch(err => console.warn('scheduler startup check failed:', err.message));

// ── SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`workspace listening on :${PORT}`));
