// Connections: one check per paid API / service the app and Claude Code depend on.
// Each check returns { id, name, group, status, balance, detail, used_by, alert_at }.
// status: 'up' | 'low' | 'down' | 'unset' (no key configured) | 'idle'.
// Balance is in USD when the provider exposes one, else null.
// Pure functions of env + network, no DB here; server.js stores the results.

const TIMEOUT_MS = 12000;

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

function basic(u, p) { return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'); }
function money(n) { return Math.round(Number(n) * 100) / 100; }

// Shared result shape. `low` decides 'low' vs 'up' when a balance exists.
function result(base, { status, balance = null, detail = '' }) {
  let s = status;
  if (s === 'up' && balance !== null && base.alert_at !== null && balance < base.alert_at) s = 'low';
  return { ...base, status: s, balance, detail };
}

const CHECKS = [
  {
    id: 'dataforseo', name: 'DataForSEO', group: 'balance', used_by: 'prospecting, audits, SEO', alert_at: 10,
    env: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    async run(env) {
      const r = await get('https://api.dataforseo.com/v3/appendix/user_data',
        { headers: { Authorization: basic(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD) } });
      const d = r.json?.tasks?.[0]?.result?.[0];
      if (!r.ok || !d) return { status: 'down', detail: `HTTP ${r.status}` };
      return { status: 'up', balance: money(d.money?.balance), detail: 'USD' };
    },
  },
  {
    id: 'twilio', name: 'Twilio', group: 'balance', used_by: 'Dialer, recordings', alert_at: 5,
    env: ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET'],
    async run(env) {
      // The API key pair is what the dialer uses, so it is the one known to be current.
      const r = await get(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Balance.json`,
        { headers: { Authorization: basic(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET) } });
      if (!r.ok || !r.json) return { status: 'down', detail: `HTTP ${r.status}` };
      return { status: 'up', balance: money(r.json.balance), detail: r.json.currency || 'USD' };
    },
  },
  {
    id: 'apify', name: 'Apify', group: 'balance', used_by: 'business-reviews scraping', alert_at: 1,
    env: ['APIFY_TOKEN'],
    async run(env) {
      const r = await get('https://api.apify.com/v2/users/me/limits', { headers: { Authorization: 'Bearer ' + env.APIFY_TOKEN } });
      const d = r.json?.data;
      if (!r.ok || !d) return { status: 'down', detail: `HTTP ${r.status}` };
      const used = Number(d.current?.monthlyUsageUsd || 0), cap = Number(d.limits?.maxMonthlyUsageUsd || 0);
      return { status: 'up', balance: money(cap - used), detail: `$${money(used)} of $${money(cap)} used this cycle` };
    },
  },
  {
    id: 'openai', name: 'OpenAI', group: 'balance', used_by: 'gpt-image-2, Codex, pplx research', alert_at: null,
    env: ['OPENAI_API_KEY'],
    async run(env) {
      const r = await get('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY } });
      if (r.status === 401) return { status: 'down', detail: 'key rejected' };
      if (!r.ok) return { status: 'down', detail: `HTTP ${r.status}` };
      return { status: 'up', detail: 'key valid, no balance API' };
    },
  },
  {
    id: 'n8n', name: 'n8n (self hosted)', group: 'plan', used_by: 'scrape button, prospecting', alert_at: null,
    env: [],
    async run(env) {
      const base = env.N8N_URL || 'https://n8n.rfisolns.org';
      const r = await get(base + '/healthz');
      return r.ok ? { status: 'up', detail: 'healthz ok' } : { status: 'down', detail: `HTTP ${r.status}` };
    },
  },
  {
    id: 'workspace', name: 'Workspace server', group: 'plan', used_by: 'everything on the Linode', alert_at: null,
    env: [],
    async run() {
      const h = Math.floor(process.uptime() / 3600);
      return { status: 'up', detail: `process up ${h}h` };
    },
  },
];

async function runOne(c, env) {
  const base = { id: c.id, name: c.name, group: c.group, used_by: c.used_by, alert_at: c.alert_at };
  const missing = c.env.filter(k => !env[k]);
  if (missing.length) return result(base, { status: 'unset', detail: 'no key on server: ' + missing.join(', ') });
  try {
    return result(base, await c.run(env));
  } catch (e) {
    return result(base, { status: 'down', detail: e.name === 'AbortError' ? 'timed out' : e.message });
  }
}

async function runChecks(env = process.env) {
  return Promise.all(CHECKS.map(c => runOne(c, env)));
}

module.exports = { runChecks, CHECKS, result };
