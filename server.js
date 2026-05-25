'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const app = express();
const PORT = parseInt(process.env.PORT || '4000');
const PASSWORD = process.env.AUTH_PASSWORD || '1225';
const DB_PATH = process.env.DB_PATH || '/data/workspace.db';

// Map of pin -> userId. AUTH_USERS="owner:1225,family:2662" or falls back to single-user.
const USERS = (() => {
  if (process.env.AUTH_USERS) {
    return Object.fromEntries(
      process.env.AUTH_USERS.split(',').map(entry => {
        const [id, pin] = entry.trim().split(':');
        return [pin, id];
      })
    );
  }
  return { [PASSWORD]: 'owner' };
})();

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const UPLOADS_DIR = path.join(dataDir, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = (file.mimetype.split('/')[1] || 'png').replace('jpeg', 'jpg');
      cb(null, crypto.randomBytes(12).toString('hex') + '.' + ext);
    }
  }),
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
try { db.exec(`ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE notes ADD COLUMN deleted_at INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN deleted_at INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recur_type TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recur_day INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recur_time TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recur_col_id TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recur_next_at INTEGER DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN due_time TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN due_reminder TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN due_notified INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN due_notify_at INTEGER DEFAULT NULL`); } catch(e) {}
// Multi-user: scope all data by user_id (existing rows default to 'owner')
try { db.exec(`ALTER TABLE notes   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE boards  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE columns ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
try { db.exec(`ALTER TABLE tasks   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}
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
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'owner',
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
try { db.exec(`ALTER TABLE push_subscriptions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`); } catch(e) {}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Workspace"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const pass = decoded.slice(colon + 1);
  const userId = USERS[pass];
  if (!userId) {
    res.set('WWW-Authenticate', 'Basic realm="Workspace"');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.userId = userId;
  next();
}

function uid() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

// ── Auth check ──────────────────────────────────────────────
app.get('/api/auth/check', auth, (req, res) => res.json({ ok: true }));

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
  res.json({ notes, boards, columns, tasks });
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
  const { column_id, title, description = '', due_date = null, due_time = null, due_reminder = null,
          due_notify_at = null,
          recur_type = null, recur_day = null, recur_time = null,
          recur_col_id = null, recur_next_at = null } = req.body;
  if (!column_id || !title) return res.status(400).json({ error: 'column_id and title required' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM tasks WHERE column_id=? AND user_id=? AND deleted_at IS NULL').get(column_id, req.userId).m;
  const id = uid(), t = now();
  db.prepare('INSERT INTO tasks (id, column_id, title, description, due_date, due_time, due_reminder, due_notify_at, recur_type, recur_day, recur_time, recur_col_id, recur_next_at, position, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, column_id, title, description, due_date, due_time, due_reminder, due_notify_at, recur_type, recur_day, recur_time, recur_col_id, recur_next_at, maxPos + 1, req.userId, t, t);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const {
    title = task.title, description = task.description,
    column_id = task.column_id, position = task.position,
    due_date = task.due_date, due_time = task.due_time, due_reminder = task.due_reminder,
    due_notify_at = task.due_notify_at,
    recur_type = task.recur_type, recur_day = task.recur_day,
    recur_time = task.recur_time, recur_col_id = task.recur_col_id,
    recur_next_at = task.recur_next_at
  } = req.body;
  const dueDateChanged = due_date !== task.due_date || due_time !== task.due_time || due_reminder !== task.due_reminder;
  const due_notified = dueDateChanged ? 0 : task.due_notified;
  db.prepare('UPDATE tasks SET title=?, description=?, column_id=?, position=?, due_date=?, due_time=?, due_reminder=?, due_notify_at=?, due_notified=?, recur_type=?, recur_day=?, recur_time=?, recur_col_id=?, recur_next_at=?, updated_at=? WHERE id=? AND user_id=?')
    .run(title, description, column_id, position, due_date, due_time, due_reminder, due_notify_at, due_notified, recur_type, recur_day, recur_time, recur_col_id, recur_next_at, now(), req.params.id, req.userId);
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
  res.json({ notes, tasks });
});

app.post('/api/trash/restore', auth, (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  if (type === 'note') db.prepare('UPDATE notes SET deleted_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'task') db.prepare('UPDATE tasks SET deleted_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else return res.status(400).json({ error: 'type must be note or task' });
  res.json({ ok: true });
});

// ── Image uploads ─────────────────────────────────────────────
app.post('/api/uploads', auth, upload.single('image'), (req, res) => {
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
    try { fs.unlinkSync(path.join(UPLOADS_DIR, name)); } catch(e) {}
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
  res.json({ ok: true });
});


// ── SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`workspace listening on :${PORT}`));
