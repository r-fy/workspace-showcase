'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const net = require('net');
const { advance, computeInitialNextFire, laWall, laEpoch } = require('./recurrence');
// web-push is in package.json (Docker installs it); tolerate a local checkout
// without node_modules so the server still boots for dev/testing.
let webpush = null;
try { webpush = require('web-push'); } catch (e) {}
// twilio powers the Calls tab (browser dialer) — same tolerance as web-push.
let twilio = null;
try { twilio = require('twilio'); } catch (e) {}
const { renderAuditHtml } = require('./audit_render');
const { SOURCES: CLIENT_CONNECTION_SOURCES } = require('./client_connections');
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


// ── Migration helpers ──────────────────────────────────────────
// These used to be `try { db.exec(...) } catch(e) {}`, which swallowed real
// failures (locked database, malformed schema, permissions) alongside the
// harmless "duplicate column name" you get from re-running an additive ALTER.
// The server then booted looking healthy and broke later, with the cause gone.
// Now only the duplicate-column case is ignored; anything else refuses the boot
// and names the statement that failed.
function addColumn(sql) {
  try { db.exec(sql); }
  catch (e) {
    if (/duplicate column name/i.test(e.message)) return; // already applied — expected on every boot after the first
    throw new Error(`Migration failed: ${sql.trim()}\n  ${e.message}`);
  }
}
// For statements that are already idempotent on their own (CREATE ... IF NOT
// EXISTS, no-op-on-rerun UPDATEs). Nothing is ignored — they should never throw.
function migrate(sql) {
  try { db.exec(sql); }
  catch (e) { throw new Error(`Migration failed: ${sql.trim()}\n  ${e.message}`); }
}

// ── Safe migrations (add-only) ─────────────────────────────────
addColumn(`ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE notes ADD COLUMN deleted_at INTEGER DEFAULT NULL`);
addColumn(`ALTER TABLE tasks ADD COLUMN deleted_at INTEGER DEFAULT NULL`);
// Archive: a separate hidden-but-recoverable state from Trash (deleted_at).
addColumn(`ALTER TABLE notes ADD COLUMN archived_at INTEGER DEFAULT NULL`);
addColumn(`ALTER TABLE tasks ADD COLUMN archived_at INTEGER DEFAULT NULL`);
addColumn(`ALTER TABLE boards ADD COLUMN archived_at INTEGER DEFAULT NULL`);
// Multi-user: scope all data by user_id (existing rows default to 'owner')
addColumn(`ALTER TABLE notes   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`);
addColumn(`ALTER TABLE boards  ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`);
addColumn(`ALTER TABLE columns ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`);
addColumn(`ALTER TABLE tasks   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'`);
// Claude mark: flags a task as greenlit for Claude Code to work on (read via direct DB query)
addColumn(`ALTER TABLE tasks ADD COLUMN claude_marked INTEGER NOT NULL DEFAULT 0`);
addColumn(`ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
// Top 3 tray: a fixed per-board column (kind='top3') for pinning up to 3 urgent tasks.
addColumn(`ALTER TABLE columns ADD COLUMN kind TEXT DEFAULT NULL`);
addColumn(`ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
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
migrate(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_cat_name ON expense_categories(user_id, name)`);
addColumn(`ALTER TABLE expenses ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE expenses ADD COLUMN frequency TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE expenses ADD COLUMN direction TEXT NOT NULL DEFAULT 'withdrawal'`);
// Pass-through: money that arrives and leaves again to the penny (IHSS caregiver
// payments) — not real income, excluded from the surplus/deficit math.
addColumn(`ALTER TABLE expenses ADD COLUMN pass_through INTEGER NOT NULL DEFAULT 0`);

// IHSS deposits are never real income (regardless of whether the matching
// outflow shows up in this ledger — it may leave via a joint/shared account
// that never posts a matching withdrawal here), so every one gets flagged.
// If an unflagged same-amount Chase Debit withdrawal DOES exist (nearest date
// wins), flag that too — a bonus, not a requirement. Idempotent — only touches
// unflagged rows, safe to call on every boot and after every import.
function matchIhssPassThrough() {
  const deposits = db.prepare(`
    SELECT id, user_id, amount, date FROM expenses
    WHERE direction='deposit' AND source='Chase Debit' AND pass_through=0 AND payee LIKE '%ihss%'
  `).all();
  const findWithdrawal = db.prepare(`
    SELECT id, date FROM expenses
    WHERE user_id=? AND direction='withdrawal' AND source='Chase Debit' AND pass_through=0 AND amount=?
  `);
  const flag = db.prepare(`UPDATE expenses SET pass_through=1, category='Pass-Through' WHERE id=?`);
  const ensureCat = db.prepare(`INSERT OR IGNORE INTO expense_categories (id, user_id, name, position)
    VALUES (?, ?, 'Pass-Through', (SELECT COALESCE(MAX(position),-1)+1 FROM expense_categories WHERE user_id=?))`);
  const passThroughUsers = db.prepare(`SELECT DISTINCT user_id FROM expenses WHERE pass_through=1`).all().map(r => r.user_id);
  const usersNeedingCat = new Set([...deposits.map(d => d.user_id), ...passThroughUsers]);
  for (const u of usersNeedingCat) ensureCat.run(uid(), u, u);
  for (const dep of deposits) {
    flag.run(dep.id);
    const candidates = findWithdrawal.all(dep.user_id, dep.amount);
    if (!candidates.length) continue;
    candidates.sort((a, b) => Math.abs(new Date(a.date) - new Date(dep.date)) - Math.abs(new Date(b.date) - new Date(dep.date)));
    flag.run(candidates[0].id);
  }
}
matchIhssPassThrough();
// Backfill: rows flagged pass-through before this categorization existed.
migrate(`UPDATE expenses SET category='Pass-Through' WHERE pass_through=1 AND category=''`);

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
addColumn(`ALTER TABLE reminders ADD COLUMN lead_minutes INTEGER DEFAULT NULL`);
addColumn(`ALTER TABLE reminders ADD COLUMN lead_fired_for INTEGER DEFAULT NULL`);
addColumn(`ALTER TABLE reminders ADD COLUMN archived_at INTEGER DEFAULT NULL`);

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
addColumn(`ALTER TABLE calls ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
addColumn(`ALTER TABLE calls ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);

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

// Follow-ups tab: one row per warm lead, an 8-touch drip sequence stored as a
// JSON blob (same blob-column pattern as audits.data) — touches is a fixed
// array of {day, type, label, body, status, due_at, sent_at}.
db.exec(`
  CREATE TABLE IF NOT EXISTS followups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    lead_name TEXT NOT NULL DEFAULT '',
    business_name TEXT NOT NULL DEFAULT 'Untitled follow-up',
    status TEXT NOT NULL DEFAULT 'active',
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id, updated_at);
`);

// TRW Daily Tasks tab: paste a prompt block, fill out the questions inline.
// questions is a JSON array of {question, answer} — same blob-column pattern
// as audits.data, no relational split needed for a per-entry Q&A list.
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    category TEXT NOT NULL DEFAULT 'business_masters',
    task_date TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    questions TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_daily_tasks_user ON daily_tasks(user_id, task_date);
`);
addColumn(`ALTER TABLE daily_tasks ADD COLUMN context TEXT NOT NULL DEFAULT ''`);

// To Do tab: Eisenhower matrix, one blank grid per calendar day (filled out
// the night before for the next day). data is a JSON blob ({do, schedule,
// delegate, delete} strings) — same blob-column pattern as audits.data.
// Unique per user+day so a save is always a plain upsert, no client-side id.
db.exec(`
  CREATE TABLE IF NOT EXISTS eisenhower_days (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    entry_date TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eisenhower_user_date ON eisenhower_days(user_id, entry_date);
`);

// Cold Email tab: daily rollup pulled from Instantly, one row per campaign per
// day — relational (not a blob like audits/daily_tasks) because this data is
// machine-pulled and time-series, the chart needs to query across dates with
// plain SQL rather than parsing JSON blobs client-side.
db.exec(`
  CREATE TABLE IF NOT EXISTS cold_email_daily (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    date TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL DEFAULT '',
    sent INTEGER NOT NULL DEFAULT 0,
    opens INTEGER NOT NULL DEFAULT 0,
    replies INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    unread_replies INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cold_email_daily_unique ON cold_email_daily(user_id, date, campaign_id);
  CREATE INDEX IF NOT EXISTS idx_cold_email_daily_date ON cold_email_daily(user_id, date);

  CREATE TABLE IF NOT EXISTS cold_email_replies (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    campaign_id TEXT NOT NULL DEFAULT '',
    campaign_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    is_unread INTEGER NOT NULL DEFAULT 0,
    ai_interest INTEGER DEFAULT NULL,
    timestamp_email INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cold_email_replies_ts ON cold_email_replies(user_id, timestamp_email);

  CREATE TABLE IF NOT EXISTS cold_email_account_health (
    account_email TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'owner',
    warmup_score INTEGER DEFAULT NULL,
    daily_limit INTEGER DEFAULT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_email)
  );
`);

// Leads tab: hub row tying together audits / followups / cold_email_replies
// for the same real-world prospect. website_domain is the only automatic
// matching key (normalized in app code); business_name text is a human hint,
// never auto-matched. See CRM-UNIFICATION-PLAN.md.
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    business_name TEXT NOT NULL DEFAULT 'Untitled lead',
    website TEXT NOT NULL DEFAULT '',
    website_domain TEXT DEFAULT NULL,
    primary_email TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT NOT NULL DEFAULT '',
    parent_lead_id TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_domain ON leads(user_id, website_domain)
    WHERE website_domain IS NOT NULL AND website_domain != '' AND deleted_at IS NULL;
`);
addColumn(`ALTER TABLE audits ADD COLUMN lead_id TEXT REFERENCES leads(id) DEFAULT NULL`);
addColumn(`ALTER TABLE followups ADD COLUMN lead_id TEXT REFERENCES leads(id) DEFAULT NULL`);
addColumn(`ALTER TABLE cold_email_replies ADD COLUMN lead_id TEXT REFERENCES leads(id) DEFAULT NULL`);
migrate(`CREATE INDEX IF NOT EXISTS idx_audits_lead ON audits(lead_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_cold_email_replies_lead ON cold_email_replies(lead_id)`);

// Client Connections tab: per-lead credentials (lead_secrets) and the last
// pulled result per source (lead_connections) — separate from the account-wide
// connections table above. Secrets never ride /api/sync or any list route;
// they're written via PUT and read back only inside a pull().
migrate(`
  CREATE TABLE IF NOT EXISTS lead_secrets (
    lead_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (lead_id, source_id, key)
  );
  CREATE TABLE IF NOT EXISTS lead_connections (
    lead_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unset',
    data TEXT NOT NULL DEFAULT '{}',
    detail TEXT NOT NULL DEFAULT '',
    checked_at INTEGER,
    PRIMARY KEY (lead_id, source_id)
  );
`);

// rfy-crm: lead contact/dial fields + disposition, and calls→lead link.
// disposition is a single current tag-system value (e.g. "warm") — colors come
// from the shared tag/color store client-side, not a new categories system.
// Calls made before this shipped stay unlinked forever (no reliable backfill
// signal) — lead_id only ever set going forward, passed by the client at dial
// time. See RFY-CRM-PLAN.md in the outreach project.
addColumn(`ALTER TABLE leads ADD COLUMN contact_name TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE leads ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE leads ADD COLUMN address TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE leads ADD COLUMN disposition TEXT NOT NULL DEFAULT ''`);
addColumn(`ALTER TABLE calls ADD COLUMN lead_id TEXT REFERENCES leads(id) DEFAULT NULL`);
migrate(`CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id)`);
// Inbound calling (v161): callbacks to the Twilio number ring the browser,
// no-answer goes to voicemail. Pre-v161 rows are all outbound by definition.
addColumn(`ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'`);

// Prospect lists (Dialer tab): a lightweight tier below CRM leads for a raw
// dial (or cold-email) list — bulk import, simple per-row outcome — before a
// contact earns a full lead record. One-click "Promote" carries a row into a
// real lead once there's signal. Deliberately NO soft-delete (unlike
// leads/calls) — this tier is disposable by design, a bad batch is nukeable
// in one click. See the "Incorporate prospect lists for dialing" Kanban task.
db.exec(`
  CREATE TABLE IF NOT EXISTS prospect_lists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    name TEXT NOT NULL DEFAULT 'Untitled list',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL REFERENCES prospect_lists(id),
    user_id TEXT NOT NULL DEFAULT 'owner',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'not_yet_called',
    promoted_lead_id TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prospects_list ON prospects(list_id, outcome);

  -- Insert-only log of every outcome pick on a prospect — powers the daily
  -- dialing stats (v180). prospects.outcome only holds the CURRENT value, so
  -- without this a day's "who got marked what" is lost the moment it's
  -- re-marked later; this keeps every day's breakdown answerable forever.
  CREATE TABLE IF NOT EXISTS prospect_outcome_events (
    id TEXT PRIMARY KEY,
    prospect_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'owner',
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prospect_outcome_events_user ON prospect_outcome_events(user_id, created_at);
`);
addColumn(`ALTER TABLE calls ADD COLUMN prospect_id TEXT REFERENCES prospects(id) DEFAULT NULL`);
migrate(`CREATE INDEX IF NOT EXISTS idx_calls_prospect ON calls(prospect_id, started_at)`);

// SMS (Texts, lives in the Dialer tab): one row per message, same
// lead/prospect-linking + webhook-signature-auth pattern as calls, no
// recording/duration fields since there's nothing to record.
db.exec(`
  CREATE TABLE IF NOT EXISTS sms_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'owner',
    message_sid TEXT UNIQUE,
    direction TEXT NOT NULL DEFAULT 'outbound',
    to_number TEXT NOT NULL DEFAULT '',
    from_number TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    lead_id TEXT REFERENCES leads(id) DEFAULT NULL,
    prospect_id TEXT REFERENCES prospects(id) DEFAULT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sms_user ON sms_messages(user_id, created_at);
`);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks POST form-encoded
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ─────────────────────────────────────────────────────
// The PIN is a login factor and nothing else. It buys a random session token at
// POST /api/auth/login; that token is what the browser stores and what every
// other route accepts. So a stolen browser credential is revocable and expires,
// and the PIN itself never sits in sessionStorage, a cookie, or IndexedDB.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- Failed-login state lives here rather than in memory so a restart doesn't
  -- hand an attacker a clean slate.
  CREATE TABLE IF NOT EXISTS login_attempts (
    identity TEXT PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
`);
// Long-lived on purpose: this is a personal app you stay logged into. Revocation
// is the lock button, not a short clock.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 60 * 60 * 1000; // only refresh last_used_at once an hour — the app polls every 2s
// After 10 failed PIN guesses an identity is locked out for 5 minutes.
const MAX_FAILS = 10, LOCK_MS = 5 * 60 * 1000;
// Each failed guess also sleeps before answering: 1s, 2s, 4s… capped at 30s. A
// hard global freeze was deliberately rejected — it would hand any stranger a
// way to lock the owner out of his own app.
const MAX_LOGIN_DELAY_MS = 30 * 1000;
const FAIL_DECAY_MS = 15 * 60 * 1000; // a quiet spell resets the counter
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
// ── Failed-login throttle (persisted) ─────────────────────────
const getAttempts = db.prepare('SELECT * FROM login_attempts WHERE identity=?');
const putAttempts = db.prepare(`INSERT INTO login_attempts (identity, fail_count, last_fail_at, locked_until)
  VALUES (?,?,?,?) ON CONFLICT(identity) DO UPDATE SET fail_count=excluded.fail_count,
  last_fail_at=excluded.last_fail_at, locked_until=excluded.locked_until`);

function lockedOut(identity) {
  const row = getAttempts.get(identity);
  return !!(row && row.locked_until > Date.now());
}
// Returns the new consecutive-failure count, which sets how long we stall before answering.
function recordFail(identity) {
  const t = Date.now();
  const row = getAttempts.get(identity);
  // A quiet spell wipes the slate: this counts a run of guesses, not a lifetime total.
  const prior = (row && t - row.last_fail_at < FAIL_DECAY_MS) ? row.fail_count : 0;
  const count = prior + 1;
  putAttempts.run(identity, count, t, count >= MAX_FAILS ? t + LOCK_MS : 0);
  if (Math.random() < 0.05) { // occasional sweep, no separate timer needed
    db.prepare('DELETE FROM login_attempts WHERE locked_until < ? AND last_fail_at < ?').run(t, t - FAIL_DECAY_MS);
  }
  return count;
}
function clearFails(identity) { db.prepare('DELETE FROM login_attempts WHERE identity=?').run(identity); }
function loginDelayMs(count) { return Math.min(2 ** (count - 1) * 1000, MAX_LOGIN_DELAY_MS); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Sessions ──────────────────────────────────────────────────
// Only the hash is stored, so a stolen database still doesn't hand over live tokens.
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?)')
    .run(hashToken(token), userId, t, t, t + SESSION_TTL_MS);
  return token;
}
function revokeSession(token) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }
// "Bearer <token>" -> userId, or null. The PIN is NOT accepted here — only at /api/auth/login.
function userFromSession(value) {
  if (!value || !value.startsWith('Bearer ')) return null;
  const row = db.prepare('SELECT user_id, last_used_at, expires_at FROM sessions WHERE token_hash=?')
    .get(hashToken(value.slice(7).trim()));
  if (!row) return null;
  const t = now();
  if (row.expires_at <= t) return null;
  if (t - row.last_used_at > SESSION_TOUCH_MS) {
    db.prepare('UPDATE sessions SET last_used_at=?, expires_at=? WHERE token_hash=?')
      .run(t, t + SESSION_TTL_MS, hashToken(value.slice(7).trim()));
  }
  return row.user_id;
}
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()); // sweep on boot

function checkAuth(req, res, next, credential) {
  const userId = userFromSession(credential);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
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

// Shared CSV line parser (quoted-field aware) — used by /api/expenses/import
// and /api/prospect-lists/:id/import, don't fork a second copy.
function parseCSVLine(line) {
  const fields = []; let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; } else inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) { fields.push(current); current = ''; }
    else current += line[i];
  }
  fields.push(current); return fields;
}

// Backfill: give every existing board a Top 3 tray column if it doesn't have one yet
// (new boards get theirs in POST /api/boards). position=-1 is cosmetic only — the
// frontend identifies this column by kind='top3', not by position.
{
  const missing = db.prepare(`SELECT id, user_id FROM boards WHERE id NOT IN (SELECT board_id FROM columns WHERE kind='top3')`).all();
  const insTop3 = db.prepare('INSERT INTO columns (id, board_id, name, position, user_id, kind) VALUES (?, ?, ?, -1, ?, ?)');
  missing.forEach(b => insTop3.run(uid(), b.id, 'Top 3', b.user_id, 'top3'));
}

// Top 3 is capped at 3 tasks — check before letting a task land in a top3 column.
// excludeTaskId lets a task already in the tray (being reordered) skip its own count.
function top3CapExceeded(columnId, userId, excludeTaskId) {
  const col = db.prepare('SELECT kind FROM columns WHERE id=? AND user_id=?').get(columnId, userId);
  if (!col || col.kind !== 'top3') return false;
  const count = db.prepare(
    'SELECT COUNT(*) AS c FROM tasks WHERE column_id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL AND id != ?'
  ).get(columnId, userId, excludeTaskId || '').c;
  return count >= 3;
}

// Shared by leads.website_domain (write time) and reply auto-matching (read
// time) so both sides normalize identically — see CRM-UNIFICATION-PLAN.md §3.
function normalizeDomain(input) {
  if (!input) return null;
  const s = input.includes('@') ? input.split('@')[1] : input;
  return s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase().trim() || null;
}

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

// ── Idempotent replays ───────────────────────────────────────
// Offline writes sit in a queue in the browser and get replayed when the
// connection comes back. A write that reached SQLite and then lost its reply on
// the way back used to be replayed and done twice — a duplicate note, task,
// reminder, expense or import. Each queued write now carries an id that survives
// retries; the id is recorded here alongside the reply, and a repeat of the same
// id gets the original reply back instead of running again.
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_ops (
    user_id TEXT NOT NULL,
    op_key TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, op_key)
  );
`);
const PROCESSED_OPS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a replay days later is not a lost reply
db.prepare('DELETE FROM processed_ops WHERE created_at < ?').run(now() - PROCESSED_OPS_TTL_MS);

app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();                       // nothing to duplicate
  const key = String(req.headers['idempotency-key'] || '').slice(0, 200);
  if (!key) return next();
  const userId = userFromSession(req.headers.authorization || '');
  if (!userId) return next();                                     // let the route answer 401 as usual
  const prior = db.prepare('SELECT status, response FROM processed_ops WHERE user_id=? AND op_key=?').get(userId, key);
  if (prior) return res.status(prior.status).type('application/json').send(prior.response);
  // Recorded on the way out, as soon as the handler answers — the mutation has
  // already committed by then (better-sqlite3 is synchronous), so the only gap
  // is a process death between the two, which is orders of magnitude narrower
  // than the network round trip this closes.
  const sendJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        db.prepare('INSERT OR REPLACE INTO processed_ops (user_id, op_key, status, response, created_at) VALUES (?,?,?,?,?)')
          .run(userId, key, res.statusCode, JSON.stringify(body), now());
      } catch (e) { console.warn('could not record idempotency key:', e.message); }
    }
    if (Math.random() < 0.02) { // occasional age sweep, no separate timer
      try { db.prepare('DELETE FROM processed_ops WHERE created_at < ?').run(now() - PROCESSED_OPS_TTL_MS); } catch (e) {}
    }
    return sendJson(body);
  };
  next();
});

// ── Auth check ──────────────────────────────────────────────
app.get('/api/auth/check', auth, (req, res) => res.json({ ok: true }));

// The ONLY place a PIN is accepted. Hands back a session token; everything else
// on the API wants "Authorization: Bearer <token>".
app.post('/api/auth/login', async (req, res) => {
  const identity = clientIp(req);
  if (lockedOut(identity)) return res.status(429).json({ error: 'Too many failed attempts — try again in a few minutes' });
  const pin = String((req.body && req.body.pin) || '');
  const userId = pin ? USERS[pin] : null;
  if (!userId) {
    // Count the miss first, then stall: concurrent guesses all see the higher count.
    const count = recordFail(identity);
    await sleep(loginDelayMs(count));
    return res.status(401).json({ error: 'Unauthorized' });
  }
  clearFails(identity);
  res.json({ token: issueSession(userId) });
});

// Locking the app revokes the token server-side, so the copy sitting in the
// browser's storage stops working the moment you lock.
app.post('/api/auth/logout', auth, (req, res) => {
  revokeSession(String(req.headers.authorization || '').slice(7).trim());
  res.json({ ok: true });
});

// rfy-crm: audits/follow-ups are always created from inside a lead now, so a
// live lead_id is REQUIRED on create (§4 of RFY-CRM-PLAN.md). On update it's
// only validated when explicitly sent — old pre-CRM unlinked rows stay
// editable, and the unlink route remains the deliberate escape hatch.
function validLeadId(userId, leadId) {
  return !!(leadId && db.prepare('SELECT 1 FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(leadId, userId));
}

// ── Audits ───────────────────────────────────────────────────
app.get('/api/audits', auth, (req, res) => {
  const rows = db.prepare('SELECT id, business_name, status, data, lead_id, updated_at FROM audits WHERE deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows.map(r => {
    let report_type = 'seo';
    try { report_type = JSON.parse(r.data).report_type || 'seo'; } catch {}
    return { id: r.id, business_name: r.business_name, status: r.status, report_type, lead_id: r.lead_id, updated_at: r.updated_at };
  }));
});

app.get('/api/audits/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM audits WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ ...a, data: JSON.parse(a.data) });
});

app.post('/api/audits', auth, (req, res) => {
  const { business_name = 'Untitled audit', data = {}, lead_id = null } = req.body;
  if (!validLeadId(req.userId, lead_id)) return res.status(400).json({ error: 'lead_id required — audits are created from inside a lead' });
  const id = uid(), t = now();
  db.prepare('INSERT INTO audits (id, business_name, status, data, lead_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, business_name, 'draft', JSON.stringify(data), lead_id, req.userId, t, t);
  res.json({ id, business_name, status: 'draft', data, lead_id, created_at: t, updated_at: t });
});

app.put('/api/audits/:id', auth, (req, res) => {
  const { business_name, status, data, lead_id } = req.body;
  if (lead_id !== undefined && !validLeadId(req.userId, lead_id)) return res.status(400).json({ error: 'lead_id must point at an existing lead' });
  const t = now();
  const a = db.prepare('SELECT * FROM audits WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE audits SET business_name=?, status=?, data=?, lead_id=?, updated_at=? WHERE id=? AND user_id=?')
    .run(business_name ?? a.business_name, status ?? a.status, JSON.stringify(data ?? JSON.parse(a.data)), lead_id !== undefined ? lead_id : a.lead_id, t, req.params.id, req.userId);
  const updated = db.prepare('SELECT * FROM audits WHERE id = ?').get(req.params.id);
  res.json({ ...updated, data: JSON.parse(updated.data) });
});

app.delete('/api/audits/:id', auth, (req, res) => {
  db.prepare('UPDATE audits SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Follow-ups (8-touch warm-lead drip sequences) ─────────────
// day offsets + type cycle locked per the Can-Ersöz-reviewed cadence:
// 8 touches over ~65 days, round-robin value-add / close-hard / new-angle.
const FOLLOWUP_TOUCH_PLAN = [
  { day: 0,  type: 'value-add' },
  { day: 4,  type: 'close-hard' },
  { day: 9,  type: 'new-angle' },
  { day: 16, type: 'value-add' },
  { day: 25, type: 'close-hard' },
  { day: 35, type: 'new-angle' },
  { day: 50, type: 'value-add' },
  { day: 65, type: 'close-hard' }, // final touch — breakup framing
];
const FOLLOWUP_TYPE_LABEL = { 'value-add': 'Value-add', 'close-hard': 'Close hard', 'new-angle': 'New angle / check-in' };
const FOLLOWUP_SKELETON = {
  'value-add': {
    body: "Hey [FIRST_NAME],\n\n[VALUE_ADD_INSIGHT — a fresh finding, screenshot, or competitor update specific to them].\n\nNo pitch here, just flagging it because it's useful either way.",
  },
  'close-hard': {
    body: "Hey [FIRST_NAME],\n\nStill open to closing that gap we found? $500/mo plus 15% of ad spend, no long-term lock-in.\n\nIf timing's off, just say so and I'll check back later. If it's a flat no, tell me that too, no hard feelings.",
  },
  'new-angle': {
    body: "Hey [FIRST_NAME],\n\n[NEW_ANGLE — a different hook than what's already been sent, e.g. a seasonal angle, a new competitor, a site change you noticed].\n\nWorth a quick look?",
  },
};
const FOLLOWUP_FINAL_TOUCH = {
  body: "Hey [FIRST_NAME],\n\nHaven't heard back so I'll leave it here. Door's open whenever it makes sense on your end, the findings don't expire.\n\nGood luck either way.",
};
function buildFollowupTouches(startAt) {
  return FOLLOWUP_TOUCH_PLAN.map((step, i) => {
    const isLast = i === FOLLOWUP_TOUCH_PLAN.length - 1;
    const skel = isLast ? FOLLOWUP_FINAL_TOUCH : FOLLOWUP_SKELETON[step.type];
    return {
      day: step.day,
      type: step.type,
      label: FOLLOWUP_TYPE_LABEL[step.type],
      body: skel.body,
      status: 'pending', // pending | sent | skipped
      due_at: startAt + step.day * 86400000,
      sent_at: null,
    };
  });
}

app.get('/api/followups', auth, (req, res) => {
  const rows = db.prepare('SELECT id, lead_name, business_name, status, data, lead_id, updated_at FROM followups WHERE deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows.map(r => {
    let touches = [];
    try { touches = JSON.parse(r.data).touches || []; } catch {}
    const next = touches.find(t => t.status === 'pending');
    return { id: r.id, lead_name: r.lead_name, business_name: r.business_name, status: r.status, lead_id: r.lead_id, updated_at: r.updated_at, next_due_at: next ? next.due_at : null, next_label: next ? next.label : null };
  }));
});

app.get('/api/followups/:id', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM followups WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.json({ ...f, data: JSON.parse(f.data) });
});

app.post('/api/followups', auth, (req, res) => {
  const { lead_name = '', business_name = 'Untitled follow-up', start_at, lead_id = null } = req.body;
  if (!validLeadId(req.userId, lead_id)) return res.status(400).json({ error: 'lead_id required — follow-ups are created from inside a lead' });
  const id = uid(), t = now();
  const data = { touches: buildFollowupTouches(start_at || t) };
  db.prepare('INSERT INTO followups (id, lead_name, business_name, status, data, lead_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, lead_name, business_name, 'active', JSON.stringify(data), lead_id, req.userId, t, t);
  res.json({ id, lead_name, business_name, status: 'active', data, lead_id, created_at: t, updated_at: t });
});

app.put('/api/followups/:id', auth, (req, res) => {
  const { lead_name, business_name, status, data, lead_id } = req.body;
  if (lead_id !== undefined && !validLeadId(req.userId, lead_id)) return res.status(400).json({ error: 'lead_id must point at an existing lead' });
  const t = now();
  const f = db.prepare('SELECT * FROM followups WHERE id = ? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!f) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE followups SET lead_name=?, business_name=?, status=?, data=?, lead_id=?, updated_at=? WHERE id=? AND user_id=?')
    .run(lead_name ?? f.lead_name, business_name ?? f.business_name, status ?? f.status, JSON.stringify(data ?? JSON.parse(f.data)), lead_id !== undefined ? lead_id : f.lead_id, t, req.params.id, req.userId);
  const updated = db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  res.json({ ...updated, data: JSON.parse(updated.data) });
});

app.delete('/api/followups/:id', auth, (req, res) => {
  db.prepare('UPDATE followups SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// Hard delete — cold_email_replies has no trash tier (it's a synced mirror of
// Instantly's inbox, not user-authored data). Dismissing a stale/spam auto-
// reply here can resurface it on the next hourly pull if Instantly still
// returns it in its last-50-received window; nothing to do about that short
// of tracking dismissals separately, not worth it unless it's a real problem.
app.delete('/api/replies/:id', auth, (req, res) => {
  db.prepare('DELETE FROM cold_email_replies WHERE id=? AND user_id=?').run(req.params.id, req.userId);
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

// ── Leads (CRM hub tying audits/followups/cold_email_replies together) ──
// See CRM-UNIFICATION-PLAN.md. business_name text is a human hint only —
// website_domain is the one automatic matching key, normalized via normalizeDomain().
function leadRollup(lead) {
  const auditCount = db.prepare('SELECT COUNT(*) c FROM audits WHERE lead_id=? AND deleted_at IS NULL').get(lead.id).c;
  const followupRow = db.prepare('SELECT data FROM followups WHERE lead_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(lead.id);
  let next_followup_due = null, next_followup_label = null;
  if (followupRow) {
    try {
      const next = (JSON.parse(followupRow.data).touches || []).find(t => t.status === 'pending');
      if (next) { next_followup_due = next.due_at; next_followup_label = next.label; }
    } catch {}
  }
  const unreadReplies = db.prepare('SELECT COUNT(*) c FROM cold_email_replies WHERE lead_id=? AND is_unread=1').get(lead.id).c;
  const lastActivity = db.prepare(`
    SELECT MAX(x) m FROM (
      SELECT MAX(updated_at) x FROM audits WHERE lead_id=? AND deleted_at IS NULL
      UNION ALL SELECT MAX(updated_at) FROM followups WHERE lead_id=? AND deleted_at IS NULL
      UNION ALL SELECT MAX(timestamp_email) FROM cold_email_replies WHERE lead_id=?
    )`).get(lead.id, lead.id, lead.id).m;
  return { audit_count: auditCount, unread_replies: unreadReplies, next_followup_due, next_followup_label, last_activity_at: lastActivity || lead.updated_at };
}

app.get('/api/leads', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads WHERE deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows.map(l => ({ ...l, ...leadRollup(l) })));
});

app.get('/api/leads/unmatched', auth, (req, res) => {
  const audits = db.prepare('SELECT id, business_name, status, updated_at FROM audits WHERE lead_id IS NULL AND deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  const followups = db.prepare('SELECT id, lead_name, business_name, status, updated_at FROM followups WHERE lead_id IS NULL AND deleted_at IS NULL AND user_id=? ORDER BY updated_at DESC').all(req.userId);
  const replies = db.prepare('SELECT id, from_email, from_name, subject, timestamp_email FROM cold_email_replies WHERE lead_id IS NULL AND user_id=? ORDER BY timestamp_email DESC').all(req.userId);
  res.json({ audits, followups, replies });
});

app.get('/api/leads/:id', auth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const leadAudits = db.prepare('SELECT id, business_name, status, data, updated_at FROM audits WHERE lead_id=? AND deleted_at IS NULL ORDER BY updated_at DESC').all(lead.id)
    .map(a => { let report_type = 'seo'; try { report_type = JSON.parse(a.data).report_type || 'seo'; } catch {} return { id: a.id, business_name: a.business_name, status: a.status, report_type, updated_at: a.updated_at }; });
  const leadFollowups = db.prepare('SELECT id, lead_name, business_name, status, data, updated_at FROM followups WHERE lead_id=? AND deleted_at IS NULL ORDER BY updated_at DESC').all(lead.id)
    .map(f => { let touches = []; try { touches = JSON.parse(f.data).touches || []; } catch {} const next = touches.find(t => t.status === 'pending'); return { id: f.id, lead_name: f.lead_name, business_name: f.business_name, status: f.status, updated_at: f.updated_at, next_due_at: next ? next.due_at : null, next_label: next ? next.label : null }; });
  const leadReplies = db.prepare('SELECT id, campaign_id, campaign_name, from_email, from_name, subject, preview, is_unread, ai_interest, timestamp_email FROM cold_email_replies WHERE lead_id=? ORDER BY timestamp_email DESC').all(lead.id);
  res.json({ ...lead, audits: leadAudits, followups: leadFollowups, replies: leadReplies });
});

// Prospect notes (Outscraper scoring template, see parseProspectScore in
// app.js) embed "Website: <url> | ..." — pulled out here so a promoted
// prospect's website survives into the lead even though it has no dedicated
// prospects.website column.
function extractWebsiteFromNotes(notes) {
  const m = String(notes || '').match(/Website:\s*([^|]*)\|/);
  return m ? m[1].trim() : '';
}

// Shared insert used by POST /api/leads and the prospect-promote route — one
// lead-creation path, not two divergent copies of the same INSERT.
function createLead(fields, userId) {
  const { business_name = 'Untitled lead', primary_email = '', city = '', niche = '', notes = '',
    contact_name = '', phone_number = '', address = '', source = '', disposition = '' } = fields;
  const website = fields.website || extractWebsiteFromNotes(notes);
  const website_domain = normalizeDomain(website);
  const id = uid(), t = now();
  db.prepare('INSERT INTO leads (id, business_name, website, website_domain, primary_email, city, niche, status, notes, contact_name, phone_number, address, source, disposition, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, business_name, website, website_domain, primary_email, city, niche, 'active', notes, contact_name, phone_number, address, source, disposition, userId, t, t);
  return db.prepare('SELECT * FROM leads WHERE id=?').get(id);
}

app.post('/api/leads', auth, (req, res) => {
  let lead;
  try { lead = createLead(req.body, req.userId); }
  catch (e) { return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A lead with this website domain already exists' : e.message }); }
  res.json(lead);
});

app.put('/api/leads/:id', auth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const { business_name, website, primary_email, city, niche, status, notes, contact_name, phone_number, address, source, disposition } = req.body;
  const website_domain = website !== undefined ? normalizeDomain(website) : lead.website_domain;
  const t = now();
  try {
    db.prepare('UPDATE leads SET business_name=?, website=?, website_domain=?, primary_email=?, city=?, niche=?, status=?, notes=?, contact_name=?, phone_number=?, address=?, source=?, disposition=?, updated_at=? WHERE id=? AND user_id=?')
      .run(business_name ?? lead.business_name, website ?? lead.website, website_domain, primary_email ?? lead.primary_email, city ?? lead.city, niche ?? lead.niche, status ?? lead.status, notes ?? lead.notes,
        contact_name ?? lead.contact_name, phone_number ?? lead.phone_number, address ?? lead.address, source ?? lead.source, disposition ?? lead.disposition, t, req.params.id, req.userId);
  } catch (e) {
    return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A lead with this website domain already exists' : e.message });
  }
  res.json(db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id));
});

app.delete('/api/leads/:id', auth, (req, res) => {
  db.prepare('UPDATE leads SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

const LEAD_LINK_TABLES = { audit: 'audits', followup: 'followups', reply: 'cold_email_replies' };

app.post('/api/leads/:id/link', auth, (req, res) => {
  const table = LEAD_LINK_TABLES[req.body.type];
  if (!table) return res.status(400).json({ error: 'type must be audit, followup, or reply' });
  const lead = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  db.prepare(`UPDATE ${table} SET lead_id=? WHERE id=? AND user_id=?`).run(lead.id, req.body.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/leads/:id/unlink', auth, (req, res) => {
  const table = LEAD_LINK_TABLES[req.body.type];
  if (!table) return res.status(400).json({ error: 'type must be audit, followup, or reply' });
  db.prepare(`UPDATE ${table} SET lead_id=NULL WHERE id=? AND lead_id=? AND user_id=?`).run(req.body.id, req.params.id, req.userId);
  res.json({ ok: true });
});

// Escape hatch for accidental duplicate leads: repoint every child row from
// the source lead onto the target, then soft-delete the source.
app.post('/api/leads/:id/merge', auth, (req, res) => {
  const source = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  const target = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.body.into_lead_id, req.userId);
  if (!source || !target) return res.status(404).json({ error: 'Lead not found' });
  const t = now();
  db.transaction(() => {
    db.prepare('UPDATE audits SET lead_id=? WHERE lead_id=? AND user_id=?').run(target.id, source.id, req.userId);
    db.prepare('UPDATE followups SET lead_id=? WHERE lead_id=? AND user_id=?').run(target.id, source.id, req.userId);
    db.prepare('UPDATE cold_email_replies SET lead_id=? WHERE lead_id=? AND user_id=?').run(target.id, source.id, req.userId);
    db.prepare('UPDATE leads SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?').run(t, t, source.id, req.userId);
  })();
  res.json({ ok: true });
});

// ── Client Connections (per-lead live data pulls) ────────────
// On-demand only, per the plan — no background poller. GET lists every source
// with its config state + last cached pull; POST .../pull runs that source's
// pull() fresh and caches the result; PUT .../config writes credentials.
function connSecretsFor(leadId, sourceId) {
  const rows = db.prepare('SELECT key, value FROM lead_secrets WHERE lead_id=? AND source_id=?').all(leadId, sourceId);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

app.get('/api/leads/:id/connections', auth, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const cached = Object.fromEntries(db.prepare('SELECT * FROM lead_connections WHERE lead_id=?').all(lead.id).map(r => [r.source_id, r]));
  res.json(CLIENT_CONNECTION_SOURCES.map(src => {
    const secrets = connSecretsFor(lead.id, src.id);
    const configured = src.fields.every(f => secrets[f.key]);
    const row = cached[src.id];
    return {
      id: src.id, name: src.name, covers: src.covers,
      fields: src.fields.map(f => ({ key: f.key, label: f.label, secret: !!f.secret, multiline: !!f.multiline, set: !!secrets[f.key] })),
      configured,
      status: row ? row.status : (configured ? 'unset' : 'unconfigured'),
      data: row ? JSON.parse(row.data) : null,
      detail: row ? row.detail : '',
      checked_at: row ? row.checked_at : null,
    };
  }));
});

app.put('/api/leads/:id/connections/:source/config', auth, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const src = CLIENT_CONNECTION_SOURCES.find(s => s.id === req.params.source);
  if (!src) return res.status(404).json({ error: 'Unknown source' });
  const t = now();
  const upsert = db.prepare(`INSERT INTO lead_secrets (lead_id, source_id, key, value, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(lead_id, source_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const f of src.fields) {
      const v = req.body[f.key];
      if (v === undefined || v === '') continue; // blank = leave the stored value alone
      upsert.run(lead.id, src.id, f.key, String(v), t);
    }
  })();
  res.json({ ok: true });
});

app.post('/api/leads/:id/connections/:source/pull', auth, async (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const src = CLIENT_CONNECTION_SOURCES.find(s => s.id === req.params.source);
  if (!src) return res.status(404).json({ error: 'Unknown source' });
  const secrets = connSecretsFor(lead.id, src.id);
  const missing = src.fields.filter(f => !secrets[f.key]);
  if (missing.length) return res.status(400).json({ error: `Not configured — missing ${missing.map(f => f.label).join(', ')}` });
  let result;
  try {
    result = await src.pull(secrets, process.env);
  } catch (e) {
    result = { status: 'down', detail: e.message };
  }
  const t = now();
  db.prepare(`INSERT INTO lead_connections (lead_id, source_id, status, data, detail, checked_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(lead_id, source_id) DO UPDATE SET status=excluded.status, data=excluded.data, detail=excluded.detail, checked_at=excluded.checked_at`)
    .run(lead.id, src.id, result.status, JSON.stringify(result.data || {}), result.detail || '', t);
  res.json({ id: src.id, status: result.status, data: result.data || {}, detail: result.detail || '', checked_at: t });
});

// ── Prospect lists (Dialer tab) ──────────────────────────────
// See the migration block above for the schema + design rationale.
const OUTCOME_TYPES = ['bad_fit', 'booked', 'follow_up_later', 'gatekeeper', 'interested', 'no_answer', 'not_interested', 'not_yet_called', 'voicemail'];

function prospectListRollup(list) {
  const rows = db.prepare('SELECT outcome, COUNT(*) c FROM prospects WHERE list_id=? GROUP BY outcome').all(list.id);
  const by_outcome = {};
  let count = 0;
  for (const r of rows) { by_outcome[r.outcome] = r.c; count += r.c; }
  return { count, by_outcome };
}

app.get('/api/prospect-lists', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM prospect_lists WHERE user_id=? ORDER BY created_at DESC').all(req.userId);
  res.json(rows.map(l => ({ ...l, ...prospectListRollup(l) })));
});

app.post('/api/prospect-lists', auth, (req, res) => {
  const name = String(req.body.name || '').trim() || 'Untitled list';
  const source = String(req.body.source || '').trim();
  const id = uid(), t = now();
  db.prepare('INSERT INTO prospect_lists (id, user_id, name, source, created_at) VALUES (?,?,?,?,?)')
    .run(id, req.userId, name, source, t);
  res.json(db.prepare('SELECT * FROM prospect_lists WHERE id=?').get(id));
});

app.get('/api/prospect-lists/:id', auth, (req, res) => {
  const list = db.prepare('SELECT * FROM prospect_lists WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const prospects = db.prepare('SELECT * FROM prospects WHERE list_id=? AND user_id=? ORDER BY created_at ASC').all(list.id, req.userId);
  res.json({ ...list, prospects });
});

// Fire-and-forget trigger for the "PROSPECTING WITH SPEED - OUTSCRAPER EDITION"
// n8n workflow (id l53vzI7Uapu9JieD) — thin proxy so N8N_SCRAPE_WEBHOOK_URL
// never ships to the browser. Results land later via the normal import route
// above; this route doesn't wait for the scrape to finish.
app.post('/api/prospect-lists/scrape', auth, async (req, res) => {
  const query = String(req.body.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });
  if (!N8N_SCRAPE_WEBHOOK_URL) return res.status(503).json({ error: 'scrape trigger not configured' });
  try {
    const r = await fetch(N8N_SCRAPE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await r.json().catch(() => ({}));
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'could not reach scrape trigger' });
  }
});

app.patch('/api/prospect-lists/:id', auth, (req, res) => {
  const list = db.prepare('SELECT id FROM prospect_lists WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE prospect_lists SET name=? WHERE id=?').run(name, list.id);
  res.json(db.prepare('SELECT * FROM prospect_lists WHERE id=?').get(list.id));
});

// Hard delete, cascades its prospects — this tier has no trash tier of its own.
app.delete('/api/prospect-lists/:id', auth, (req, res) => {
  const list = db.prepare('SELECT id FROM prospect_lists WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!list) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare('UPDATE calls SET prospect_id=NULL WHERE prospect_id IN (SELECT id FROM prospects WHERE list_id=?) AND user_id=?').run(list.id, req.userId);
    db.prepare('DELETE FROM prospects WHERE list_id=? AND user_id=?').run(list.id, req.userId);
    db.prepare('DELETE FROM prospect_lists WHERE id=? AND user_id=?').run(list.id, req.userId);
  })();
  res.json({ ok: true });
});

// Bulk import: either a pasted CSV (header-driven, reuses the shared
// parseCSVLine) or a plain JSON rows array — the latter is the path the
// future Outscraper n8n workflow will POST into directly, no API change needed.
app.post('/api/prospect-lists/:id/import', auth, (req, res) => {
  const list = db.prepare('SELECT * FROM prospect_lists WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!list) return res.status(404).json({ error: 'Not found' });
  let rawRows;
  if (typeof req.body.csv === 'string' && req.body.csv.trim()) {
    const lines = req.body.csv.split(/\r?\n/).filter(l => l.trim());
    rawRows = [];
    if (lines.length) {
      const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
      const cols = ['name', 'phone', 'email', 'source', 'city', 'niche', 'notes'];
      const idx = Object.fromEntries(cols.map(c => [c, header.indexOf(c)]));
      for (let i = 1; i < lines.length; i++) {
        const f = parseCSVLine(lines[i]);
        const row = {};
        for (const c of cols) row[c] = idx[c] >= 0 ? (f[idx[c]] || '').trim() : '';
        rawRows.push(row);
      }
    }
  } else if (Array.isArray(req.body.rows)) {
    rawRows = req.body.rows;
  } else {
    return res.status(400).json({ error: 'csv string or rows array required' });
  }
  const ins = db.prepare('INSERT INTO prospects (id, list_id, user_id, name, phone, email, source, city, niche, notes, outcome, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const t = now();
  let imported = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rawRows) {
      const name = String(r.name || '').trim();
      const phone = String(r.phone || '').trim();
      const email = String(r.email || '').trim();
      if (!name && !phone && !email) { skipped++; continue; } // nothing to dial or email
      const source = String(r.source || '').trim() || list.source;
      ins.run(uid(), list.id, req.userId, name, phone, email, source,
        String(r.city || '').trim(), String(r.niche || '').trim(), String(r.notes || '').trim(),
        'not_yet_called', t, t);
      imported++;
    }
  })();
  res.json({ imported, skipped });
});

app.put('/api/prospects/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { name = p.name, phone = p.phone, email = p.email, source = p.source, city = p.city, niche = p.niche, notes = p.notes, outcome = p.outcome } = req.body;
  if (!OUTCOME_TYPES.includes(outcome)) return res.status(400).json({ error: 'invalid outcome' });
  const t = now();
  db.prepare('UPDATE prospects SET name=?, phone=?, email=?, source=?, city=?, niche=?, notes=?, outcome=?, updated_at=? WHERE id=? AND user_id=?')
    .run(name, phone, email, source, city, niche, notes, outcome, t, req.params.id, req.userId);
  if (outcome !== p.outcome) {
    db.prepare('INSERT INTO prospect_outcome_events (id, prospect_id, user_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uid(), req.params.id, req.userId, outcome, t);
  }
  res.json(db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id));
});

// Fix a bad import line — single-row hard delete (the list itself has its own
// hard-delete above for nuking a whole bad batch). calls.prospect_id is a
// real FK (unlike prospect_outcome_events, which has none) — a dialed
// prospect can't be deleted without unlinking its calls first, same
// "old calls stay unlinked forever" precedent as deleting a lead.
app.delete('/api/prospects/:id', auth, (req, res) => {
  db.transaction(() => {
    db.prepare('UPDATE calls SET prospect_id=NULL WHERE prospect_id=? AND user_id=?').run(req.params.id, req.userId);
    db.prepare('DELETE FROM prospects WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  })();
  res.json({ ok: true });
});

// Real signal earned it: create a lead via the same insert POST /api/leads
// uses, map the fields across, and mark the row promoted (stays in the list —
// "old calls stay unlinked forever" philosophy, don't rewrite history).
app.post('/api/prospects/:id/promote', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  let lead;
  try {
    lead = createLead({
      business_name: p.name || 'Untitled lead',
      phone_number: p.phone,
      primary_email: p.email,
      source: p.source,
      city: p.city,
      niche: p.niche,
      notes: p.notes,
    }, req.userId);
  } catch (e) {
    return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A lead with this website domain already exists' : e.message });
  }
  db.prepare('UPDATE prospects SET promoted_lead_id=?, updated_at=? WHERE id=? AND user_id=?').run(lead.id, now(), p.id, req.userId);
  res.json(lead);
});

// Clears the prospect-side promoted flag only — never touches the lead
// itself (it may still be live, or already deleted from CRM; either way this
// is just "stop showing this prospect as promoted"). Lets a bad/premature
// promote be undone without losing whatever real data the lead accumulated.
app.post('/api/prospects/:id/unpromote', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE prospects SET promoted_lead_id=NULL, updated_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id));
});

// ── TRW Daily Tasks ──────────────────────────────────────────
const DAILY_TASK_CATEGORIES = ['business_masters', 'daily_marketing', 'daily_seo_task'];

app.get('/api/daily-tasks', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM daily_tasks WHERE deleted_at IS NULL AND user_id=? ORDER BY task_date DESC, created_at DESC').all(req.userId);
  res.json(rows.map(r => ({ ...r, questions: JSON.parse(r.questions) })));
});

app.get('/api/daily-tasks/:id', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM daily_tasks WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, questions: JSON.parse(r.questions) });
});

function dailyTaskFields(body) {
  const category = DAILY_TASK_CATEGORIES.includes(body.category) ? body.category : 'business_masters';
  const task_date = /^\d{4}-\d{2}-\d{2}$/.test(body.task_date) ? body.task_date : null;
  if (!task_date) return { error: 'task_date (YYYY-MM-DD) required' };
  const questions = Array.isArray(body.questions)
    ? body.questions.map(q => ({ question: String(q.question || '').trim(), answer: String(q.answer || '') }))
      .filter(q => q.question)
    : [];
  if (!questions.length) return { error: 'at least one question required' };
  return { category, task_date, source_url: String(body.source_url || '').trim(), context: String(body.context || '').trim(), questions };
}

app.post('/api/daily-tasks', auth, (req, res) => {
  const f = dailyTaskFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const id = uid(), t = now();
  db.prepare('INSERT INTO daily_tasks (id, user_id, category, task_date, source_url, context, questions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, f.category, f.task_date, f.source_url, f.context, JSON.stringify(f.questions), t, t);
  res.json({ ...db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(id), questions: f.questions });
});

app.put('/api/daily-tasks/:id', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM daily_tasks WHERE id=? AND user_id=? AND deleted_at IS NULL').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const f = dailyTaskFields({ category: r.category, task_date: r.task_date, source_url: r.source_url, context: r.context, ...req.body });
  if (f.error) return res.status(400).json({ error: f.error });
  const t = now();
  db.prepare('UPDATE daily_tasks SET category=?, task_date=?, source_url=?, context=?, questions=?, updated_at=? WHERE id=? AND user_id=?')
    .run(f.category, f.task_date, f.source_url, f.context, JSON.stringify(f.questions), t, req.params.id, req.userId);
  res.json({ ...db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(req.params.id), questions: f.questions });
});

app.delete('/api/daily-tasks/:id', auth, (req, res) => {
  db.prepare('UPDATE daily_tasks SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// ── To Do (Eisenhower matrix) ──────────────────────────────────
app.get('/api/eisenhower/:date', auth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const r = db.prepare('SELECT data FROM eisenhower_days WHERE user_id=? AND entry_date=?').get(req.userId, req.params.date);
  res.json(r ? JSON.parse(r.data) : {});
});

app.put('/api/eisenhower/:date', auth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const data = {
    do: String(req.body.do || ''),
    schedule: String(req.body.schedule || ''),
    delegate: String(req.body.delegate || ''),
    delete: String(req.body.delete || ''),
  };
  const t = now();
  db.prepare(`
    INSERT INTO eisenhower_days (id, user_id, entry_date, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, entry_date) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
  `).run(uid(), req.userId, req.params.date, JSON.stringify(data), t, t);
  res.json(data);
});

// ── Cold Email (Instantly reporting) ──────────────────────────
// Hits Instantly's REST API directly (this is a server process, it can't use
// the Claude-side Instantly MCP connection that only exists in interactive
// sessions) — same tolerate-missing-config pattern as Twilio above: without
// the key the tab just stays empty instead of crashing.
// Endpoints + field names below were verified live against the real API
// (not guessed) — see COLD_EMAIL_WORKSPACE_SECTION_PLAN.md in the outreach
// repo for how. Two things worth remembering if this ever looks wrong:
// - /campaigns/analytics/daily has no bounce field at all (Instantly only
//   tracks bounces as a period total, via /campaigns/analytics/overview),
//   so bounces here are a per-pull period total stashed on the latest day's
//   row, not a true daily breakdown.
// - opened/unique_opened will read 0 for campaigns with open_tracking off
//   (which Raffi's campaigns deliberately run with, per Can's
//   deliverability-first method) — that's accurate, not a bug.
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || '';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
if (!INSTANTLY_API_KEY) console.warn('cold email pull disabled — INSTANTLY_API_KEY not configured');

// n8n webhook URL that kicks off the Outscraper prospecting workflow — see
// POST /api/prospect-lists/scrape below. Never logged, never sent to the client.
const N8N_SCRAPE_WEBHOOK_URL = process.env.N8N_SCRAPE_WEBHOOK_URL || '';
if (!N8N_SCRAPE_WEBHOOK_URL) console.warn('scrape-new-prospects button disabled — N8N_SCRAPE_WEBHOOK_URL not configured');

async function instantlyGet(path) {
  const res = await fetch(INSTANTLY_BASE + path, { headers: { Authorization: 'Bearer ' + INSTANTLY_API_KEY } });
  if (!res.ok) throw new Error('Instantly API ' + res.status + ' on ' + path);
  return res.json();
}

let coldEmailPullRunning = false;
let coldEmailLastAttemptAt = null;
let coldEmailLastSuccessAt = null;
let coldEmailLastError = null;
async function pullColdEmailStats() {
  if (!INSTANTLY_API_KEY || coldEmailPullRunning) return;
  coldEmailPullRunning = true;
  coldEmailLastAttemptAt = now();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const campaignsResp = await instantlyGet('/campaigns');
    const campaigns = campaignsResp.items || [];
    const t = now();
    const upsertDaily = db.prepare(`
      INSERT INTO cold_email_daily (id, user_id, date, campaign_id, campaign_name, sent, opens, replies, bounces, unread_replies, updated_at)
      VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(user_id, date, campaign_id) DO UPDATE SET
        campaign_name=excluded.campaign_name, sent=excluded.sent, opens=excluded.opens,
        replies=excluded.replies, updated_at=excluded.updated_at
    `);
    for (const c of campaigns) {
      let daily = [];
      try {
        // Plain array, not wrapped in items/result — confirmed against the live API.
        daily = await instantlyGet(`/campaigns/analytics/daily?campaign_id=${c.id}&start_date=${startDate}&end_date=${today}`);
      } catch (e) {
        console.warn('cold email: daily analytics failed for campaign', c.id, e.message);
        continue;
      }
      let latestDate = null;
      for (const d of daily) {
        upsertDaily.run(c.id + ':' + d.date, d.date, c.id, c.name || '', d.sent || 0, d.opened || 0, d.replies || 0, t);
        if (!latestDate || d.date > latestDate) latestDate = d.date;
      }
      if (!latestDate) continue;
      try {
        const overview = await instantlyGet(`/campaigns/analytics/overview?id=${c.id}&start_date=${startDate}&end_date=${today}`);
        db.prepare(`UPDATE cold_email_daily SET bounces=? WHERE user_id='owner' AND date=? AND campaign_id=?`)
          .run(overview.bounced_count || 0, latestDate, c.id);
      } catch (e) { console.warn('cold email: overview (bounces) failed for campaign', c.id, e.message); }
    }
    try {
      const unread = await instantlyGet('/emails/unread/count');
      // Workspace-wide number, not per-campaign — stash it against today's
      // most-recently-touched campaign row rather than invent a
      // campaign-less row the UI has no place to display.
      db.prepare(`UPDATE cold_email_daily SET unread_replies=? WHERE user_id='owner' AND date=? AND campaign_id = (
        SELECT campaign_id FROM cold_email_daily WHERE user_id='owner' AND date=? ORDER BY updated_at DESC LIMIT 1
      )`).run(unread.count || 0, today, today);
    } catch (e) { console.warn('cold email: unread count failed', e.message); }

    try {
      const accountsResp = await instantlyGet('/accounts');
      const accounts = accountsResp.items || [];
      const upsertAcct = db.prepare(`
        INSERT INTO cold_email_account_health (account_email, user_id, warmup_score, daily_limit, updated_at)
        VALUES (?, 'owner', ?, ?, ?)
        ON CONFLICT(user_id, account_email) DO UPDATE SET
          warmup_score=excluded.warmup_score, daily_limit=excluded.daily_limit, updated_at=excluded.updated_at
      `);
      for (const a of accounts) {
        upsertAcct.run(a.email, a.stat_warmup_score ?? null, a.daily_limit ?? null, t);
      }
    } catch (e) { console.warn('cold email: account health failed', e.message); }

    try {
      const campaignNameById = Object.fromEntries(campaigns.map(c => [c.id, c.name || '']));
      const emailsResp = await instantlyGet('/emails?email_type=received&limit=50');
      const emails = emailsResp.items || [];
      const upsertReply = db.prepare(`
        INSERT INTO cold_email_replies (id, user_id, campaign_id, campaign_name, from_email, from_name, subject, preview, thread_id, is_unread, ai_interest, timestamp_email, updated_at)
        VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          campaign_name=excluded.campaign_name, from_email=excluded.from_email, from_name=excluded.from_name,
          subject=excluded.subject, preview=excluded.preview, is_unread=excluded.is_unread,
          ai_interest=excluded.ai_interest, updated_at=excluded.updated_at
      `);
      for (const e of emails) {
        const fromInfo = (e.from_address_json && e.from_address_json[0]) || {};
        upsertReply.run(
          e.id, e.campaign_id || '', campaignNameById[e.campaign_id] || '',
          e.from_address_email || fromInfo.address || '', fromInfo.name || '',
          e.subject || '', e.content_preview || '', e.thread_id || '',
          e.is_unread ? 1 : 0, e.ai_interest_value ?? null,
          new Date(e.timestamp_email || e.timestamp_created).getTime(), t
        );
      }
    } catch (e) { console.warn('cold email: replies failed', e.message); }

    // Auto-link replies to leads by normalized domain match — only ever
    // touches lead_id IS NULL rows, so it never fights a manual correction.
    try {
      const domainLeads = db.prepare(`SELECT id, website_domain FROM leads WHERE user_id='owner' AND website_domain IS NOT NULL AND website_domain != '' AND deleted_at IS NULL`).all();
      if (domainLeads.length) {
        const byDomain = new Map(domainLeads.map(l => [l.website_domain, l.id]));
        const unmatched = db.prepare(`SELECT id, from_email FROM cold_email_replies WHERE user_id='owner' AND lead_id IS NULL`).all();
        const link = db.prepare('UPDATE cold_email_replies SET lead_id=? WHERE id=?');
        for (const r of unmatched) {
          const d = normalizeDomain(r.from_email);
          if (d && byDomain.has(d)) link.run(byDomain.get(d), r.id);
        }
      }
    } catch (e) { console.warn('cold email: lead domain-match failed', e.message); }

    coldEmailLastSuccessAt = now();
    coldEmailLastError = null;
  } catch (e) {
    console.warn('cold email pull failed:', e.message);
    coldEmailLastError = e.message;
  } finally {
    coldEmailPullRunning = false;
  }
}
setInterval(() => pullColdEmailStats().catch(err => console.warn('cold email pull tick failed:', err.message)), 60 * 60 * 1000);
pullColdEmailStats().catch(err => console.warn('cold email startup pull failed:', err.message));

app.get('/api/cold-email/daily', auth, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT date, campaign_id, campaign_name, sent, opens, replies, bounces, unread_replies
    FROM cold_email_daily WHERE user_id=? AND date>=? ORDER BY date ASC`).all(req.userId, since);
  res.json(rows);
});

app.get('/api/cold-email/accounts', auth, (req, res) => {
  const rows = db.prepare(`SELECT account_email, warmup_score, daily_limit, updated_at
    FROM cold_email_account_health WHERE user_id=? ORDER BY account_email ASC`).all(req.userId);
  res.json(rows);
});

app.post('/api/cold-email/pull', auth, async (req, res) => {
  if (!INSTANTLY_API_KEY) return res.status(503).json({ error: 'INSTANTLY_API_KEY not configured' });
  await pullColdEmailStats();
  res.json({ ok: true });
});

app.get('/api/cold-email/replies', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const rows = db.prepare(`SELECT id, campaign_id, campaign_name, from_email, from_name, subject, preview,
    thread_id, is_unread, ai_interest, timestamp_email, lead_id
    FROM cold_email_replies WHERE user_id=? ORDER BY timestamp_email DESC LIMIT ?`).all(req.userId, limit);
  res.json(rows);
});

app.get('/api/cold-email/status', auth, (req, res) => {
  res.json({
    configured: !!INSTANTLY_API_KEY,
    last_attempt_at: coldEmailLastAttemptAt,
    last_success_at: coldEmailLastSuccessAt,
    last_error: coldEmailLastError,
  });
});

// ── Notes ────────────────────────────────────────────────────
app.get('/api/notes', auth, (req, res) => {
  res.json(db.prepare('SELECT id, title, updated_at, position FROM notes WHERE deleted_at IS NULL AND archived_at IS NULL AND user_id=? ORDER BY position ASC').all(req.userId));
});

app.get('/api/notes/:id', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(req.params.id, req.userId);
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.json(note);
});

app.post('/api/notes', auth, (req, res) => {
  const { title = 'Untitled', content = '' } = req.body;
  const id = uid(), t = now();
  db.prepare('UPDATE notes SET position = position + 1 WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL').run(req.userId);
  db.prepare('INSERT INTO notes (id, title, content, user_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(id, title, content, req.userId, t, t);
  res.json({ id, title, content, position: 0, created_at: t, updated_at: t });
});

app.put('/api/notes/:id', auth, (req, res) => {
  const { title, content, tags, position } = req.body;
  const t = now();
  const n = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(req.params.id, req.userId);
  if (!n) return res.status(404).json({ error: 'Not found' });
  if (position !== undefined && title === undefined && content === undefined && tags === undefined) {
    db.prepare('UPDATE notes SET position=? WHERE id=? AND user_id=?').run(position, req.params.id, req.userId);
  } else {
    db.prepare('UPDATE notes SET title=?, content=?, tags=?, updated_at=? WHERE id=? AND user_id=?')
      .run(title ?? n.title, content ?? n.content, tags ?? n.tags ?? '', t, req.params.id, req.userId);
  }
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id));
});

// Soft-delete note (moves to trash) — only reachable now via the Archive tab's "Delete forever"
app.delete('/api/notes/:id', auth, (req, res) => {
  db.prepare('UPDATE notes SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/notes/:id/archive', auth, (req, res) => {
  db.prepare('UPDATE notes SET archived_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
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
// Daily cold-calling stats (v180): dial count, first-dial time, total talk
// time, and per-outcome counts, all scoped to a single LA calendar day and
// all prospect lists combined. Bounded to that day's epoch range via
// laEpoch, so this stays cheap even as call/event history grows — no full
// table scans. Re-marking a prospect twice in the same day only counts its
// LAST outcome that day (events are read in created_at order).
function laDateStr(epochMs) {
  const w = laWall(epochMs);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}
function laDayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = laEpoch(y, m, d, 0, 0);
  const nd = new Date(Date.UTC(y, m - 1, d + 1));
  const end = laEpoch(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), 0, 0);
  return { start, end };
}
function computeProspectStatsForDate(userId, dateStr) {
  const { start, end } = laDayBounds(dateStr);
  const calls = db.prepare('SELECT started_at, duration FROM calls WHERE user_id=? AND prospect_id IS NOT NULL AND started_at >= ? AND started_at < ?')
    .all(userId, start, end);
  const events = db.prepare('SELECT prospect_id, outcome FROM prospect_outcome_events WHERE user_id=? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC')
    .all(userId, start, end);
  const lastPerProspect = {};
  for (const e of events) lastPerProspect[e.prospect_id] = e.outcome; // ASC order — last write wins
  const by_outcome = {};
  for (const outcome of Object.values(lastPerProspect)) by_outcome[outcome] = (by_outcome[outcome] || 0) + 1;
  let first_dial_at = null, talk_seconds = 0;
  for (const c of calls) {
    if (first_dial_at === null || c.started_at < first_dial_at) first_dial_at = c.started_at;
    talk_seconds += c.duration || 0;
  }
  return { date: dateStr, dial_count: calls.length, first_dial_at, talk_seconds, by_outcome };
}
app.get('/api/prospect-stats', auth, (req, res) => {
  const date = req.query.date || laDateStr(now());
  res.json(computeProspectStatsForDate(req.userId, date));
});

// The app polls this every 2 seconds per open tab, and the vast majority of
// those windows contain no changes at all. So the payload is fingerprinted:
// the client sends back the last fingerprint it saw as If-None-Match, and an
// unchanged fingerprint gets a tiny { unchanged: true } instead of the whole
// database. The response shape when data HAS changed is byte-identical to
// before. (Cheap tier by design — see F4/F4b in CODEX-FINDINGS-REGISTER.md.
// The queries still run; what this removes is the transfer and the client-side
// rewrite, which is where the cost actually was.)
app.get('/api/sync', auth, (req, res) => {
  const notes = db.prepare('SELECT * FROM notes WHERE deleted_at IS NULL AND archived_at IS NULL AND user_id=? ORDER BY position ASC').all(req.userId);
  const boards = db.prepare('SELECT * FROM boards WHERE archived_at IS NULL AND user_id=? ORDER BY position').all(req.userId);
  const columns = db.prepare('SELECT * FROM columns WHERE user_id=? ORDER BY position').all(req.userId);
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND user_id=? ORDER BY position').all(req.userId);
  const reminders = db.prepare('SELECT * FROM reminders WHERE deleted_at IS NULL AND archived_at IS NULL AND user_id=? AND (completed_at IS NULL OR completed_at > ?) ORDER BY next_fire_at ASC')
    .all(req.userId, now() - COMPLETED_KEEP_MS);
  // Newest 200 calls only — this rides the 2s poll, keep the payload bounded.
  const calls = db.prepare('SELECT * FROM calls WHERE user_id=? ORDER BY started_at DESC LIMIT 200').all(req.userId);
  const sms = db.prepare('SELECT * FROM sms_messages WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.userId);
  const prospect_lists = db.prepare('SELECT * FROM prospect_lists WHERE user_id=? ORDER BY created_at DESC').all(req.userId)
    .map(l => ({ ...l, ...prospectListRollup(l) }));
  const prospects = db.prepare('SELECT * FROM prospects WHERE user_id=? ORDER BY created_at ASC').all(req.userId);
  const prospect_stats_today = computeProspectStatsForDate(req.userId, laDateStr(now()));
  const body = JSON.stringify({ notes, boards, columns, tasks, reminders, calls, sms, prospect_lists, prospects, prospect_stats_today });
  const version = crypto.createHash('sha1').update(body).digest('hex');
  // Deliberately NOT ETag/If-None-Match. Those are standard HTTP cache
  // semantics, and every layer in the path acts on them: Express turns a
  // matching If-None-Match into a bodyless 304 before our JSON ever goes out,
  // and Cloudflare rewrites strong ETags to weak. A private header keeps this
  // fingerprint ours alone, with no cache layer interpreting it.
  res.set('X-Sync-Version', version);
  res.set('Cache-Control', 'no-store');
  if (req.headers['x-sync-version'] === version) return res.json({ unchanged: true });
  res.type('application/json').send(body);
});

// ── Boards ────────────────────────────────────────────────────
app.get('/api/boards', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM boards WHERE archived_at IS NULL AND user_id=? ORDER BY position, created_at').all(req.userId));
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
  db.prepare('INSERT INTO columns (id, board_id, name, position, user_id, kind) VALUES (?, ?, ?, -1, ?, ?)')
    .run(uid(), id, 'Top 3', req.userId, 'top3');
  res.json(db.prepare('SELECT * FROM boards WHERE id = ?').get(id));
});

app.put('/api/boards/:id', auth, (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!board) return res.status(404).json({ error: 'Not found' });
  const { name = board.name, position = board.position } = req.body;
  db.prepare('UPDATE boards SET name=?, position=? WHERE id=? AND user_id=?').run(name, position, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id));
});

// Permanent hard-delete — boards have no trash tier, only reachable via the
// Archive tab's "Delete forever" (archive first, then this).
app.delete('/api/boards/:id', auth, (req, res) => {
  db.prepare('DELETE FROM boards WHERE id = ? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/boards/:id/archive', auth, (req, res) => {
  db.prepare('UPDATE boards SET archived_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Columns ───────────────────────────────────────────────────
app.get('/api/boards/:boardId/columns', auth, (req, res) => {
  const cols = db.prepare('SELECT * FROM columns WHERE board_id=? AND user_id=? ORDER BY position').all(req.params.boardId, req.userId);
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL AND user_id=? AND column_id IN (SELECT id FROM columns WHERE board_id=?) ORDER BY position'
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
  if (top3CapExceeded(column_id, req.userId, null)) return res.status(400).json({ error: 'Top 3 is full' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) AS m FROM tasks WHERE column_id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(column_id, req.userId).m;
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
  if (column_id !== task.column_id && top3CapExceeded(column_id, req.userId, task.id)) {
    return res.status(400).json({ error: 'Top 3 is full' });
  }
  db.prepare('UPDATE tasks SET title=?, description=?, column_id=?, position=?, claude_marked=?, tags=?, updated_at=? WHERE id=? AND user_id=?')
    .run(title, description, column_id, position, claude_marked ? 1 : 0, tags, now(), req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id));
});

// Bulk soft-delete — only reachable now via the Archive tab's "Delete forever"
app.delete('/api/tasks', auth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const del = db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?');
  const t = now();
  db.transaction(() => ids.forEach(id => del.run(t, id, req.userId)))();
  res.json({ deleted: ids.length });
});

// Soft-delete single task — only reachable now via the Archive tab's "Delete forever"
app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('UPDATE tasks SET deleted_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/tasks/archive', auth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const arc = db.prepare('UPDATE tasks SET archived_at=? WHERE id=? AND user_id=?');
  const t = now();
  db.transaction(() => ids.forEach(id => arc.run(t, id, req.userId)))();
  res.json({ archived: ids.length });
});

app.post('/api/tasks/:id/archive', auth, (req, res) => {
  db.prepare('UPDATE tasks SET archived_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
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

// ── Archive ───────────────────────────────────────────────────
// Hidden-but-recoverable state, separate from Trash. Notes/tasks/reminders/
// boards all archive here; "delete forever" hands notes/tasks/reminders off
// to the existing Trash (deleted_at) so restore/empty logic isn't duplicated.
// Boards have no trash tier, so their "delete forever" is a real hard delete.
app.get('/api/archive', auth, (req, res) => {
  const notes = db.prepare('SELECT id, title, archived_at FROM notes WHERE archived_at IS NOT NULL AND deleted_at IS NULL AND user_id=? ORDER BY archived_at DESC').all(req.userId);
  const tasks = db.prepare('SELECT id, title, column_id, archived_at FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL AND user_id=? ORDER BY archived_at DESC').all(req.userId);
  const reminders = db.prepare('SELECT id, title, archived_at FROM reminders WHERE archived_at IS NOT NULL AND deleted_at IS NULL AND user_id=? ORDER BY archived_at DESC').all(req.userId);
  const boards = db.prepare('SELECT id, name, archived_at FROM boards WHERE archived_at IS NOT NULL AND user_id=? ORDER BY archived_at DESC').all(req.userId);
  res.json({ notes, tasks, reminders, boards });
});

app.post('/api/archive/restore', auth, (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  if (type === 'note') db.prepare('UPDATE notes SET archived_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'task') db.prepare('UPDATE tasks SET archived_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'reminder') db.prepare('UPDATE reminders SET archived_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else if (type === 'board') db.prepare('UPDATE boards SET archived_at=NULL WHERE id=? AND user_id=?').run(id, req.userId);
  else return res.status(400).json({ error: 'type must be note, task, reminder, or board' });
  res.json({ ok: true });
});

app.post('/api/archive/delete', auth, (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  if (type === 'note') db.prepare('UPDATE notes SET deleted_at=?, archived_at=NULL WHERE id=? AND user_id=?').run(now(), id, req.userId);
  else if (type === 'task') db.prepare('UPDATE tasks SET deleted_at=?, archived_at=NULL WHERE id=? AND user_id=?').run(now(), id, req.userId);
  else if (type === 'reminder') db.prepare('UPDATE reminders SET deleted_at=?, archived_at=NULL WHERE id=? AND user_id=?').run(now(), id, req.userId);
  else if (type === 'board') db.prepare('DELETE FROM boards WHERE id=? AND user_id=?').run(id, req.userId);
  else return res.status(400).json({ error: 'type must be note, task, reminder, or board' });
  res.json({ ok: true });
});


// ── Expenses ──────────────────────────────────────────────────
app.get('/api/expenses', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, created_at DESC').all(req.userId));
});

app.post('/api/expenses', auth, (req, res) => {
  const { amount, date, category = '', payee = '', note = '', source = '', frequency = '', direction = 'withdrawal', pass_through = 0 } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const id = uid(), t = now();
  db.prepare('INSERT INTO expenses (id, user_id, amount, date, category, payee, note, source, frequency, direction, pass_through, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, parseFloat(amount), date, category, payee, note, source, frequency, direction, pass_through ? 1 : 0, t);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(id));
});

app.put('/api/expenses/:id', auth, (req, res) => {
  const exp = db.prepare('SELECT * FROM expenses WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!exp) return res.status(404).json({ error: 'Not found' });
  const { amount = exp.amount, date = exp.date, category = exp.category, payee = exp.payee, note = exp.note, source = exp.source, frequency = exp.frequency, direction = exp.direction, pass_through = exp.pass_through } = req.body;
  db.prepare('UPDATE expenses SET amount=?, date=?, category=?, payee=?, note=?, source=?, frequency=?, direction=?, pass_through=? WHERE id=? AND user_id=?')
    .run(parseFloat(amount), date, category, payee, note, source, frequency, direction, pass_through ? 1 : 0, req.params.id, req.userId);
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
  const lines = ['date,amount,category,payee,source,frequency,direction,pass_through,note'];
  for (const r of rows) lines.push([r.date, r.amount, r.category, r.payee, r.source, r.frequency, r.direction, r.pass_through, r.note].map(csvField).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="expenses.csv"');
  res.send(lines.join('\n'));
});

app.post('/api/expenses/import', auth, (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv string required' });
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return res.json({ imported: 0 });
  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const [dateIdx, amountIdx, categoryIdx, payeeIdx, sourceIdx, frequencyIdx, directionIdx, passThroughIdx, noteIdx] =
    ['date','amount','category','payee','source','frequency','direction','pass_through','note'].map(k => header.indexOf(k));
  if (dateIdx < 0 || amountIdx < 0) return res.status(400).json({ error: 'CSV must have date and amount columns' });
  const ins = db.prepare('INSERT INTO expenses (id, user_id, amount, date, category, payee, note, source, frequency, direction, pass_through, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
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
        passThroughIdx >= 0 ? (f[passThroughIdx]?.trim() === '1' ? 1 : 0) : 0,
        t);
      imported++;
    }
  })();
  matchIhssPassThrough();
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
  res.json(db.prepare('SELECT * FROM reminders WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL AND (completed_at IS NULL OR completed_at > ?) ORDER BY next_fire_at ASC')
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
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(req.params.id, req.userId);
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

app.post('/api/reminders/:id/archive', auth, (req, res) => {
  db.prepare('UPDATE reminders SET archived_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/reminders/:id/complete', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(req.params.id, req.userId);
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
  const r = db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(req.params.id, req.userId);
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
  // incomingAllow flipped true in v161 — lead callbacks ring the browser now.
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: true }));
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

// Same formatting the client's fmtPhone does — used in push notification
// bodies so a US number reads as (555) 123-4567, not raw E.164.
function fmtPhoneDisplay(n) {
  const m = String(n || '').match(/^\+1([2-9]\d{2})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || 'Unknown number');
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
    // rfy-crm: the dial pad lives inside a lead's Calls sub-tab, so the client
    // passes LeadId as a custom connect() param. Validate it belongs to this
    // user before trusting it; a call placed with no/bad LeadId just stays
    // unlinked (no auto-match by phone — normal path always knows the lead).
    const rawLeadId = String(req.body.LeadId || '');
    const leadId = rawLeadId && db.prepare('SELECT 1 FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(rawLeadId, userId) ? rawLeadId : null;
    // Same pattern as LeadId — dialProspect() passes ProspectId so the daily
    // stats bar can attribute this call's talk time to a specific prospect.
    const rawProspectId = String(req.body.ProspectId || '');
    const prospectId = rawProspectId && db.prepare('SELECT 1 FROM prospects WHERE id=? AND user_id=?').get(rawProspectId, userId) ? rawProspectId : null;
    db.prepare(`INSERT OR IGNORE INTO calls (id, user_id, call_sid, to_number, from_number, status, lead_id, prospect_id, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'initiated', ?, ?, ?, ?)`)
      .run(uid(), userId, req.body.CallSid || null, to, TWILIO_CALLER_ID, leadId, prospectId, now(), now());
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

// ── Inbound calling (v161) ────────────────────────────────────
// The phone NUMBER's Voice URL points at /api/twilio/inbound (the TwiML
// App's Voice URL stays on /api/twilio/voice for outbound browser dials).
// Flow: ring the registered browser client for 15s → answered: normal
// bridged call, recorded like outbound → not answered / rejected / browser
// closed: voicemail (greeting + record), missed-call push notification.
// Caller is matched to a lead by last-10-digits against leads.phone_number.
// "Rahfee" is a deliberate phonetic respelling — the TTS voice mispronounced
// "Raffi" (it's RAH-fee, one word). Callers only ever HEAR this text.
const VOICEMAIL_GREETING = "You've reached Rahfee. I can't take your call right now. Leave your name and number and I'll call you right back.";
const VOICEMAIL_VOICE = 'Polly.Matthew-Neural';

function last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }
function leadByPhone(userId, num) {
  const target = last10(num);
  if (target.length < 10) return null;
  return db.prepare(`SELECT id, business_name, phone_number FROM leads WHERE user_id=? AND deleted_at IS NULL AND phone_number != ''`)
    .all(userId).find(l => last10(l.phone_number) === target) || null;
}

app.post('/api/twilio/inbound', twilioWebhook, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const from = String(req.body.From || '');
  const userId = Object.values(USERS)[0]; // single-user app — inbound always rings the owner
  const lead = leadByPhone(userId, from);
  db.prepare(`INSERT OR IGNORE INTO calls (id, user_id, call_sid, to_number, from_number, status, direction, lead_id, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'ringing', 'inbound', ?, ?, ?)`)
    .run(uid(), userId, req.body.CallSid || null, TWILIO_CALLER_ID, from, lead ? lead.id : null, now(), now());
  const dial = twiml.dial({
    timeout: 15,                                 // ~4 rings, then voicemail
    answerOnBridge: true,
    record: 'record-from-answer-dual',
    recordingStatusCallback: '/api/twilio/recording-status',
    recordingStatusCallbackEvent: 'completed',
    action: '/api/twilio/inbound-status',
  });
  dial.client(userId);
  res.type('text/xml').send(twiml.toString());
});

// <Dial> finished: answered → close out the row like outbound; anything else
// → mark missed, play the greeting, record a voicemail (the recording lands
// on this same call row via the shared recording-status webhook — a missed
// row WITH a recording_sid is displayed as "Voicemail", without as "Missed").
app.post('/api/twilio/inbound-status', twilioWebhook, (req, res) => {
  const { CallSid, DialCallStatus, DialCallDuration, From } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();
  if (DialCallStatus === 'completed' || DialCallStatus === 'answered') {
    db.prepare('UPDATE calls SET status=?, duration=?, ended_at=? WHERE call_sid=?')
      .run('completed', parseInt(DialCallDuration, 10) || 0, now(), CallSid);
  } else {
    db.prepare(`UPDATE calls SET status='missed', ended_at=? WHERE call_sid=?`).run(now(), CallSid);
    const userId = Object.values(USERS)[0];
    const lead = leadByPhone(userId, From);
    sendPushToUser(userId, {
      type: 'call',
      title: 'Missed call' + (lead ? ' — ' + lead.business_name : ''),
      body: (From || 'Unknown number') + ' — check Workspace for a voicemail.',
    }).catch(() => {});
    twiml.say({ voice: VOICEMAIL_VOICE }, VOICEMAIL_GREETING);
    twiml.record({
      maxLength: 120,
      playBeep: true,
      recordingStatusCallback: '/api/twilio/recording-status',
      recordingStatusCallbackEvent: 'completed',
    });
  }
  res.type('text/xml').send(twiml.toString());
});

app.get('/api/calls', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM calls WHERE user_id=? ORDER BY started_at DESC LIMIT 200').all(req.userId));
});

// ── SMS (Texts, Dialer tab) ────────────────────────────────────
// The phone NUMBER's Messaging URL points here — same signature-validated
// public-webhook pattern as the voice webhooks above, no PIN auth.
app.post('/api/twilio/sms', twilioWebhook, (req, res) => {
  const from = String(req.body.From || '');
  const userId = Object.values(USERS)[0]; // single-user app — inbound always lands with the owner
  const lead = leadByPhone(userId, from);
  db.prepare(`INSERT OR IGNORE INTO sms_messages (id, user_id, message_sid, direction, to_number, from_number, body, status, lead_id, created_at)
    VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'received', ?, ?)`)
    .run(uid(), userId, req.body.MessageSid || null, TWILIO_CALLER_ID, from, req.body.Body || '', lead ? lead.id : null, now());
  // Leads with the sender's number (not just the lead name) — until the
  // Twilio number is A2P 10DLC-registered, replies can't send from the app,
  // so this number is what Raffi texts back from his own personal cell.
  sendPushToUser(userId, {
    type: 'sms',
    title: 'New text — ' + fmtPhoneDisplay(from) + (lead ? ' (' + lead.business_name + ')' : ''),
    body: (req.body.Body || '').slice(0, 150) || '(no message body)',
  }).catch(() => {});
  res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString()); // empty = no auto-reply
});

app.get('/api/sms', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM sms_messages WHERE user_id=? ORDER BY created_at DESC LIMIT 500').all(req.userId));
});

// Raw fetch + Basic auth, same convention as the recordings/usage calls
// below rather than the twilio SDK client — logs the row from Twilio's own
// response so message_sid/status are always accurate.
app.post('/api/sms/send', auth, async (req, res) => {
  if (!twilioEnabled) return res.status(503).json({ error: 'twilio not configured' });
  const to = normalizeE164(req.body.to);
  const body = String(req.body.body || '').trim();
  if (!to) return res.status(400).json({ error: 'bad number' });
  if (!body) return res.status(400).json({ error: 'empty message' });
  const rawLeadId = String(req.body.leadId || '');
  const leadId = rawLeadId && db.prepare('SELECT 1 FROM leads WHERE id=? AND user_id=? AND deleted_at IS NULL').get(rawLeadId, req.userId) ? rawLeadId : null;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_CALLER_ID, To: to, Body: body }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.message || 'Twilio send failed' });
    const id = uid();
    db.prepare(`INSERT INTO sms_messages (id, user_id, message_sid, direction, to_number, from_number, body, status, lead_id, created_at)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`)
      .run(id, req.userId, data.sid, to, TWILIO_CALLER_ID, body, data.status || 'queued', leadId, now());
    res.json(db.prepare('SELECT * FROM sms_messages WHERE id=?').get(id));
  } catch (err) {
    console.warn('sms send failed:', err.message);
    res.status(502).json({ error: 'could not reach Twilio' });
  }
});

// Star (favorite) a recording and/or leave yourself a note on it — personal
// feedback on how the call went, kept with the recording rather than in a
// separate system.
app.put('/api/calls/:id', auth, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!call) return res.status(404).json({ error: 'Not found' });
  const { starred = call.starred, notes = call.notes } = req.body;
  db.prepare('UPDATE calls SET starred=?, notes=? WHERE id=? AND user_id=?').run(starred ? 1 : 0, notes, req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id));
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
        // TTL 5min: a brief connectivity gap right at fire time (device
        // asleep, Doze, dead zone) used to silently drop the notification
        // forever at TTL 60s — a few minutes of retry window turns that into
        // "slightly late" instead of "never arrived," without going so long
        // it shows up stale.
        { urgency: 'high', TTL: 300 }
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
      WHERE next_fire_at IS NOT NULL AND next_fire_at <= ? AND completed_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL`).all(t);
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
      WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND completed_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL`).all(t);
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
        AND completed_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL`).all(t, t);
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


// ── Connections: hourly health + balance check of every paid API / MCP we lean on.
// Server-side checks live in connections.js. Claude Code's MCP list can only be
// read on the Mac, so scripts/connections-client.js posts it here hourly.
const { runChecks } = require('./connections');
migrate(`CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'server',
  data TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  alerted_at INTEGER DEFAULT NULL
)`);
const OWNER_ID = Object.values(USERS)[0] || 'owner';
let connectionsRunning = false;

// Reminders for low/down services were removed at Raffi's request (2026-08-30) —
// the Connections tab itself is the alerting surface now. Kept as a stub so the
// two callers and the alerted_at column stay untouched.
function alertConnection(row, prev) {
  return prev?.alerted_at || null;
}

async function refreshConnections() {
  if (connectionsRunning) return;
  connectionsRunning = true;
  try {
    const rows = await runChecks(process.env);
    const t = now();
    const sel = db.prepare('SELECT alerted_at FROM connections WHERE id=?');
    const up = db.prepare(`INSERT INTO connections (id, source, data, checked_at, alerted_at) VALUES (?, 'server', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, checked_at=excluded.checked_at, alerted_at=excluded.alerted_at`);
    for (const r of rows) up.run(r.id, JSON.stringify(r), t, alertConnection(r, sel.get(r.id)));
    // A check removed from connections.js (Perplexity, 2026-08-22) must leave the board too.
    const keep = new Set(rows.map(r => r.id));
    for (const r of db.prepare("SELECT id FROM connections WHERE source='server'").all())
      if (!keep.has(r.id)) db.prepare('DELETE FROM connections WHERE id=?').run(r.id);
  } finally { connectionsRunning = false; }
}

app.get('/api/connections', auth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM connections ORDER BY source, id').all()
    .map(r => ({ ...JSON.parse(r.data), source: r.source, checked_at: r.checked_at }));
  res.json({ rows, now: now() });
});

app.post('/api/connections/check', auth, async (_req, res) => {
  try { await refreshConnections(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Mac-side MCP report: [{id,name,status,detail}] from `claude mcp list`.
app.post('/api/connections/mcp', auth, (req, res) => {
  const list = Array.isArray(req.body?.servers) ? req.body.servers : null;
  if (!list) return res.status(400).json({ error: 'servers[] required' });
  const t = now();
  const up = db.prepare(`INSERT INTO connections (id, source, data, checked_at, alerted_at) VALUES (?, 'mcp', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, checked_at=excluded.checked_at, alerted_at=excluded.alerted_at`);
  const sel = db.prepare('SELECT alerted_at FROM connections WHERE id=?');
  const keep = new Set();
  for (const s of list.slice(0, 100)) {
    const name = String(s.name || '').slice(0, 80); if (!name) continue;
    const id = 'mcp:' + name; keep.add(id);
    const row = { id, name, group: 'mcp', status: s.status === 'up' ? 'up' : 'down', balance: null,
      detail: String(s.detail || '').slice(0, 200), used_by: 'Claude Code', alert_at: null, kind: String(s.kind || '').slice(0, 20) };
    up.run(id, JSON.stringify(row), t, alertConnection(row, sel.get(id)));
  }
  // Servers removed from Claude Code disappear from the board.
  for (const r of db.prepare("SELECT id FROM connections WHERE source='mcp'").all())
    if (!keep.has(r.id)) db.prepare('DELETE FROM connections WHERE id=?').run(r.id);
  res.json({ ok: true, count: keep.size });
});

setInterval(() => refreshConnections().catch(err => console.warn('connections tick failed:', err.message)), 60 * 60 * 1000);
refreshConnections().catch(err => console.warn('connections startup check failed:', err.message));

// ── SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`workspace listening on :${PORT}`));
