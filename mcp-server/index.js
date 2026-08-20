#!/usr/bin/env node
'use strict';
// Local stdio MCP server fronting Raffi's Workspace REST API (server.js).
// See CLAUDE.md's "MCP server" section for setup. Build spec: BUILD-SPEC-mcp-server.md.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.WORKSPACE_URL || 'https://workspace.rfisolns.org').replace(/\/+$/, '');
const PIN = process.env.WORKSPACE_PIN;
if (!PIN) {
  console.error('FATAL: WORKSPACE_PIN env var not set. Add it to this MCP server\'s launch config.');
  process.exit(1);
}
// Cloudflare in front of workspace.rfisolns.org 403s the default Node/curl
// User-Agent as a bot fingerprint — looks exactly like a bad PIN but isn't.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The PIN only works at /api/auth/login now; every other route wants the session
// token that hands back. Fetched on first use, kept for the life of the process,
// and re-fetched once if the server ever rejects it (expired, or revoked because
// the app's lock button was pressed).
let sessionToken = null;
async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ pin: PIN }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}${res.status === 401 ? ' (wrong WORKSPACE_PIN?)' : ''}`);
  sessionToken = (await res.json()).token;
  if (!sessionToken) throw new Error('login returned no token');
  return sessionToken;
}

async function rawApi(method, path, body) {
  return fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + sessionToken,
      'User-Agent': USER_AGENT,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function api(method, path, body) {
  if (!sessionToken) await login();
  let res = await rawApi(method, path, body);
  if (res.status === 401) { await login(); res = await rawApi(method, path, body); }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `HTTP ${res.status} on ${method} ${path}`;
    throw new Error(msg);
  }
  return data;
}

const server = new McpServer({ name: 'workspace', version: '1.0.0' });

// Every tool returns JSON as a text block, and thrown errors become isError
// results instead of crashing the server — one wrapper, not one per tool.
function defineTool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const result = await handler(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  });
}

function need(v, field) {
  if (v === undefined || v === null || v === '') throw new Error(`${field} required`);
  return v;
}

// ── workspace_sync ───────────────────────────────────────────────
defineTool(
  'workspace_sync',
  'Get a full snapshot of everything: notes, boards, columns, tasks, reminders, calls, sms, prospect lists, prospects, and today\'s prospect stats. Cheap, useful for orienting before doing anything else. No parameters.',
  {},
  () => api('GET', '/api/sync')
);

// ── workspace_notes ──────────────────────────────────────────────
defineTool(
  'workspace_notes',
  `Notes CRUD. action: "list" (returns id/title/updated_at/position, no content) | "get" (id) | "create" (title?, content?) | "update" (id, title?, content?, tags?, position?) | "delete" (id, soft-delete to trash) | "archive" (id) | "import" (files: [{name, content}]).`,
  {
    action: z.enum(['list', 'get', 'create', 'update', 'delete', 'archive', 'import']),
    id: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.string().optional().describe('comma-separated tag names'),
    position: z.number().optional(),
    files: z.array(z.object({ name: z.string(), content: z.string() })).optional(),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/notes');
      case 'get': return api('GET', `/api/notes/${need(a.id, 'id')}`);
      case 'create': return api('POST', '/api/notes', { title: a.title, content: a.content });
      case 'update': return api('PUT', `/api/notes/${need(a.id, 'id')}`, { title: a.title, content: a.content, tags: a.tags, position: a.position });
      case 'delete': return api('DELETE', `/api/notes/${need(a.id, 'id')}`);
      case 'archive': return api('POST', `/api/notes/${need(a.id, 'id')}/archive`);
      case 'import': return api('POST', '/api/notes/import', { files: need(a.files, 'files') });
    }
  }
);

// ── workspace_tasks (boards / columns / tasks) ───────────────────
defineTool(
  'workspace_tasks',
  `Kanban boards/columns/tasks. action:
"board_list" | "board_create" (name, columns?: string[] of column names) | "board_update" (id, name?, position?) | "board_delete" (id, permanent — no trash tier, archive first) | "board_archive" (id) | "board_columns" (id — lists a board's columns with their tasks nested) |
"column_create" (board_id, name) | "column_update" (id, name?, position?) | "column_delete" (id) |
"task_create" (column_id, title, description?, claude_marked?, tags?) | "task_update" (id, title?, description?, column_id?, position?, claude_marked?, tags?) | "task_delete" (id, soft-delete) | "task_bulk_delete" (ids: string[]) | "task_archive" (id) | "task_bulk_archive" (ids: string[]).
Note: every board has a fixed "Top 3" tray column (kind=top3, capped at 3 tasks) — moving a 4th task in fails with an error.`,
  {
    action: z.enum(['board_list', 'board_create', 'board_update', 'board_delete', 'board_archive', 'board_columns',
      'column_create', 'column_update', 'column_delete',
      'task_create', 'task_update', 'task_delete', 'task_bulk_delete', 'task_archive', 'task_bulk_archive']),
    id: z.string().optional(),
    board_id: z.string().optional(),
    column_id: z.string().optional(),
    name: z.string().optional(),
    columns: z.array(z.string()).optional(),
    position: z.number().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    claude_marked: z.boolean().optional(),
    tags: z.string().optional(),
    ids: z.array(z.string()).optional(),
  },
  (a) => {
    switch (a.action) {
      case 'board_list': return api('GET', '/api/boards');
      case 'board_create': return api('POST', '/api/boards', { name: need(a.name, 'name'), columns: a.columns });
      case 'board_update': return api('PUT', `/api/boards/${need(a.id, 'id')}`, { name: a.name, position: a.position });
      case 'board_delete': return api('DELETE', `/api/boards/${need(a.id, 'id')}`);
      case 'board_archive': return api('POST', `/api/boards/${need(a.id, 'id')}/archive`);
      case 'board_columns': return api('GET', `/api/boards/${need(a.id, 'id')}/columns`);
      case 'column_create': return api('POST', '/api/columns', { board_id: need(a.board_id, 'board_id'), name: need(a.name, 'name') });
      case 'column_update': return api('PUT', `/api/columns/${need(a.id, 'id')}`, { name: a.name, position: a.position });
      case 'column_delete': return api('DELETE', `/api/columns/${need(a.id, 'id')}`);
      case 'task_create': return api('POST', '/api/tasks', { column_id: need(a.column_id, 'column_id'), title: need(a.title, 'title'), description: a.description, claude_marked: a.claude_marked ? 1 : 0, tags: a.tags });
      case 'task_update': return api('PUT', `/api/tasks/${need(a.id, 'id')}`, { title: a.title, description: a.description, column_id: a.column_id, position: a.position, claude_marked: a.claude_marked !== undefined ? (a.claude_marked ? 1 : 0) : undefined, tags: a.tags });
      case 'task_delete': return api('DELETE', `/api/tasks/${need(a.id, 'id')}`);
      case 'task_bulk_delete': return api('DELETE', '/api/tasks', { ids: need(a.ids, 'ids') });
      case 'task_archive': return api('POST', `/api/tasks/${need(a.id, 'id')}/archive`);
      case 'task_bulk_archive': return api('POST', '/api/tasks/archive', { ids: need(a.ids, 'ids') });
    }
  }
);

// ── workspace_reminders ───────────────────────────────────────────
defineTool(
  'workspace_reminders',
  `Calendar reminders. action: "list" | "create" | "update" (id + any field) | "delete" (id) | "delete_completed" (clears all completed) | "archive" (id) | "complete" (id) | "snooze" (id, minutes 1-10080).
Fields for create/update: title, description?, first_fire_at (epoch ms, required on create), recur_type ('none'|'daily'|'weekly'|'monthly'|'yearly'), recur_interval (every N, default 1), recur_weekdays (comma-separated 0-6, weekly only), recur_end_at (epoch ms), lead_minutes (fire an extra alert N minutes early).
Timezone: all recurrence math is America/Los_Angeles wall-clock — Raffi is in Pacific time, convert any "9am" style request to Pacific before computing first_fire_at.`,
  {
    action: z.enum(['list', 'create', 'update', 'delete', 'delete_completed', 'archive', 'complete', 'snooze']),
    id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    first_fire_at: z.number().optional().describe('epoch ms'),
    recur_type: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
    recur_interval: z.number().optional(),
    recur_weekdays: z.string().optional().describe('comma-separated 0-6, e.g. "1,3,5"'),
    recur_end_at: z.number().optional().describe('epoch ms'),
    lead_minutes: z.number().optional(),
    minutes: z.number().optional().describe('snooze duration, 1-10080'),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/reminders');
      case 'create': return api('POST', '/api/reminders', {
        title: need(a.title, 'title'), description: a.description, first_fire_at: need(a.first_fire_at, 'first_fire_at'),
        recur_type: a.recur_type, recur_interval: a.recur_interval, recur_weekdays: a.recur_weekdays,
        recur_end_at: a.recur_end_at, lead_minutes: a.lead_minutes,
      });
      case 'update': return api('PUT', `/api/reminders/${need(a.id, 'id')}`, {
        title: a.title, description: a.description, first_fire_at: a.first_fire_at,
        recur_type: a.recur_type, recur_interval: a.recur_interval, recur_weekdays: a.recur_weekdays,
        recur_end_at: a.recur_end_at, lead_minutes: a.lead_minutes,
      });
      case 'delete': return api('DELETE', `/api/reminders/${need(a.id, 'id')}`);
      case 'delete_completed': return api('DELETE', '/api/reminders/completed');
      case 'archive': return api('POST', `/api/reminders/${need(a.id, 'id')}/archive`);
      case 'complete': return api('POST', `/api/reminders/${need(a.id, 'id')}/complete`);
      case 'snooze': return api('POST', `/api/reminders/${need(a.id, 'id')}/snooze`, { minutes: need(a.minutes, 'minutes') });
    }
  }
);

// ── workspace_expenses ────────────────────────────────────────────
defineTool(
  'workspace_expenses',
  `Expense log. action: "list" | "create" | "update" (id + fields) | "delete" (id) | "categories_list" | "category_create" (name) | "category_delete" (name) | "export_csv" | "import_csv" (csv: string with a header row).
Fields for create/update: amount, date (YYYY-MM-DD), category?, payee?, note?, source?, frequency?, direction? ('withdrawal'|'deposit', default withdrawal).`,
  {
    action: z.enum(['list', 'create', 'update', 'delete', 'categories_list', 'category_create', 'category_delete', 'export_csv', 'import_csv']),
    id: z.string().optional(),
    amount: z.number().optional(),
    date: z.string().optional().describe('YYYY-MM-DD'),
    category: z.string().optional(),
    payee: z.string().optional(),
    note: z.string().optional(),
    source: z.string().optional(),
    frequency: z.string().optional(),
    direction: z.enum(['withdrawal', 'deposit']).optional(),
    name: z.string().optional().describe('category name, for category_create/category_delete'),
    csv: z.string().optional().describe('CSV text with a header row (date,amount,category,payee,source,frequency,direction,note) for import_csv'),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/expenses');
      case 'create': return api('POST', '/api/expenses', { amount: need(a.amount, 'amount'), date: need(a.date, 'date'), category: a.category, payee: a.payee, note: a.note, source: a.source, frequency: a.frequency, direction: a.direction });
      case 'update': return api('PUT', `/api/expenses/${need(a.id, 'id')}`, { amount: a.amount, date: a.date, category: a.category, payee: a.payee, note: a.note, source: a.source, frequency: a.frequency, direction: a.direction });
      case 'delete': return api('DELETE', `/api/expenses/${need(a.id, 'id')}`);
      case 'categories_list': return api('GET', '/api/expense-categories');
      case 'category_create': return api('POST', '/api/expense-categories', { name: need(a.name, 'name') });
      case 'category_delete': return api('DELETE', `/api/expense-categories/${encodeURIComponent(need(a.name, 'name'))}`);
      case 'export_csv': return api('GET', '/api/expenses/export.csv');
      case 'import_csv': return api('POST', '/api/expenses/import', { csv: need(a.csv, 'csv') });
    }
  }
);

// ── workspace_leads ────────────────────────────────────────────────
defineTool(
  'workspace_leads',
  `CRM leads. action: "list" (with rollup badges) | "get" (id — includes its audits/followups/replies timeline) | "unmatched" (audits/followups/replies not yet linked to a lead) | "create" | "update" (id + fields) | "delete" (id) | "link" (id=lead id, type: 'audit'|'followup'|'reply', item_id) | "unlink" (same shape as link) | "merge" (id=source lead id, into_lead_id=target — repoints children, soft-deletes source).
Fields for create/update: business_name, website?, primary_email?, city?, niche?, status?, notes?, contact_name?, phone_number?, address?, source?, disposition?.`,
  {
    action: z.enum(['list', 'get', 'unmatched', 'create', 'update', 'delete', 'link', 'unlink', 'merge']),
    id: z.string().optional(),
    business_name: z.string().optional(),
    website: z.string().optional(),
    primary_email: z.string().optional(),
    city: z.string().optional(),
    niche: z.string().optional(),
    status: z.string().optional(),
    notes: z.string().optional(),
    contact_name: z.string().optional(),
    phone_number: z.string().optional(),
    address: z.string().optional(),
    source: z.string().optional(),
    disposition: z.string().optional(),
    type: z.enum(['audit', 'followup', 'reply']).optional().describe('for link/unlink'),
    item_id: z.string().optional().describe('the audit/followup/reply id, for link/unlink'),
    into_lead_id: z.string().optional().describe('merge target lead id'),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/leads');
      case 'get': return api('GET', `/api/leads/${need(a.id, 'id')}`);
      case 'unmatched': return api('GET', '/api/leads/unmatched');
      case 'create': return api('POST', '/api/leads', {
        business_name: a.business_name, website: a.website, primary_email: a.primary_email, city: a.city, niche: a.niche,
        notes: a.notes, contact_name: a.contact_name, phone_number: a.phone_number, address: a.address, source: a.source, disposition: a.disposition,
      });
      case 'update': return api('PUT', `/api/leads/${need(a.id, 'id')}`, {
        business_name: a.business_name, website: a.website, primary_email: a.primary_email, city: a.city, niche: a.niche, status: a.status,
        notes: a.notes, contact_name: a.contact_name, phone_number: a.phone_number, address: a.address, source: a.source, disposition: a.disposition,
      });
      case 'delete': return api('DELETE', `/api/leads/${need(a.id, 'id')}`);
      case 'link': return api('POST', `/api/leads/${need(a.id, 'id')}/link`, { type: need(a.type, 'type'), id: need(a.item_id, 'item_id') });
      case 'unlink': return api('POST', `/api/leads/${need(a.id, 'id')}/unlink`, { type: need(a.type, 'type'), id: need(a.item_id, 'item_id') });
      case 'merge': return api('POST', `/api/leads/${need(a.id, 'id')}/merge`, { into_lead_id: need(a.into_lead_id, 'into_lead_id') });
    }
  }
);

// ── workspace_audits ──────────────────────────────────────────────
defineTool(
  'workspace_audits',
  `Local SEO / Google Ads audit reports (client-ready written reports, one JSON blob per audit). action: "list" | "get" (id) | "create" (business_name?, data?, lead_id — REQUIRED, audits must belong to a lead) | "update" (id, business_name?, status?, data?, lead_id?) | "delete" (id).
data is the full audit blob (identity, gbp/ranking situation rows, findings with sources, heatmaps, gsc, narrative, report_type: 'seo'|'ads'). Rendering to HTML/PDF is not exposed here (browser-only feature).`,
  {
    action: z.enum(['list', 'get', 'create', 'update', 'delete']),
    id: z.string().optional(),
    business_name: z.string().optional(),
    status: z.string().optional(),
    data: z.record(z.any()).optional(),
    lead_id: z.string().optional(),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/audits');
      case 'get': return api('GET', `/api/audits/${need(a.id, 'id')}`);
      case 'create': return api('POST', '/api/audits', { business_name: a.business_name, data: a.data, lead_id: need(a.lead_id, 'lead_id') });
      case 'update': return api('PUT', `/api/audits/${need(a.id, 'id')}`, { business_name: a.business_name, status: a.status, data: a.data, lead_id: a.lead_id });
      case 'delete': return api('DELETE', `/api/audits/${need(a.id, 'id')}`);
    }
  }
);

// ── workspace_followups ───────────────────────────────────────────
defineTool(
  'workspace_followups',
  `Warm-lead 8-touch follow-up drip sequences. action: "list" | "get" (id) | "create" (lead_name?, business_name?, start_at?: epoch ms, lead_id — REQUIRED) | "update" (id, lead_name?, business_name?, status?, data?, lead_id?) | "delete" (id).
create auto-generates the 8-touch schedule (day 0/4/9/16/25/35/50/65, value-add/close-hard/new-angle cycle) into data.touches — pass data on update to edit individual touches (status: pending|sent|skipped).`,
  {
    action: z.enum(['list', 'get', 'create', 'update', 'delete']),
    id: z.string().optional(),
    lead_name: z.string().optional(),
    business_name: z.string().optional(),
    status: z.string().optional(),
    data: z.record(z.any()).optional(),
    lead_id: z.string().optional(),
    start_at: z.number().optional().describe('epoch ms, defaults to now'),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/followups');
      case 'get': return api('GET', `/api/followups/${need(a.id, 'id')}`);
      case 'create': return api('POST', '/api/followups', { lead_name: a.lead_name, business_name: a.business_name, start_at: a.start_at, lead_id: need(a.lead_id, 'lead_id') });
      case 'update': return api('PUT', `/api/followups/${need(a.id, 'id')}`, { lead_name: a.lead_name, business_name: a.business_name, status: a.status, data: a.data, lead_id: a.lead_id });
      case 'delete': return api('DELETE', `/api/followups/${need(a.id, 'id')}`);
    }
  }
);

// ── workspace_prospects (prospect lists, Dialer tab) ──────────────
defineTool(
  'workspace_prospects',
  `Prospect lists — the disposable tier below CRM leads (bulk import a raw dial list, work it, promote winners to real leads). No soft-delete: delete is permanent. action:
"list_lists" | "create_list" (name, source?) | "get_list" (list_id — includes its prospects) | "rename_list" (list_id, name) | "delete_list" (list_id, hard-deletes + cascades its prospects) |
"scrape" (query — fires the n8n Outscraper workflow async, results land later via import) |
"import" (list_id, csv? string with header name,phone,email,source,city,niche,notes OR rows? array of {name,phone,email,source,city,niche,notes}) |
"update" (id=prospect id, name?, phone?, email?, source?, city?, niche?, notes?, outcome?) |
"delete" (id=prospect id) | "promote" (id=prospect id, creates a real lead) | "unpromote" (id=prospect id) |
"stats" (date?: YYYY-MM-DD, defaults to today LA time — dial count, first dial time, talk seconds, per-outcome breakdown).
outcome values: not_yet_called, no_answer, voicemail, interested, booked, not_interested, gatekeeper, follow_up_later, bad_fit.`,
  {
    action: z.enum(['list_lists', 'create_list', 'get_list', 'rename_list', 'delete_list', 'scrape', 'import', 'update', 'delete', 'promote', 'unpromote', 'stats']),
    list_id: z.string().optional(),
    id: z.string().optional().describe('prospect id, for update/delete/promote/unpromote'),
    name: z.string().optional(),
    source: z.string().optional(),
    query: z.string().optional().describe('scrape search query, e.g. "locksmith in Reno NV"'),
    csv: z.string().optional(),
    rows: z.array(z.record(z.any())).optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    city: z.string().optional(),
    niche: z.string().optional(),
    notes: z.string().optional(),
    outcome: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD, for stats'),
  },
  (a) => {
    switch (a.action) {
      case 'list_lists': return api('GET', '/api/prospect-lists');
      case 'create_list': return api('POST', '/api/prospect-lists', { name: need(a.name, 'name'), source: a.source });
      case 'get_list': return api('GET', `/api/prospect-lists/${need(a.list_id, 'list_id')}`);
      case 'rename_list': return api('PATCH', `/api/prospect-lists/${need(a.list_id, 'list_id')}`, { name: need(a.name, 'name') });
      case 'delete_list': return api('DELETE', `/api/prospect-lists/${need(a.list_id, 'list_id')}`);
      case 'scrape': return api('POST', '/api/prospect-lists/scrape', { query: need(a.query, 'query') });
      case 'import': return api('POST', `/api/prospect-lists/${need(a.list_id, 'list_id')}/import`, { csv: a.csv, rows: a.rows });
      case 'update': return api('PUT', `/api/prospects/${need(a.id, 'id')}`, { name: a.name, phone: a.phone, email: a.email, source: a.source, city: a.city, niche: a.niche, notes: a.notes, outcome: a.outcome });
      case 'delete': return api('DELETE', `/api/prospects/${need(a.id, 'id')}`);
      case 'promote': return api('POST', `/api/prospects/${need(a.id, 'id')}/promote`);
      case 'unpromote': return api('POST', `/api/prospects/${need(a.id, 'id')}/unpromote`);
      case 'stats': return api('GET', `/api/prospect-stats${a.date ? '?date=' + encodeURIComponent(a.date) : ''}`);
    }
  }
);

// ── workspace_daily_tasks (TRW Daily Tasks + Eisenhower matrix) ───
defineTool(
  'workspace_daily_tasks',
  `TRW daily task Q&A entries, plus the Eisenhower matrix (To Do tab). action:
"list" | "get" (id) | "create" (category, task_date, questions: [{question,answer}], source_url?, context?) | "update" (id + fields) | "delete" (id) |
"eisenhower_get" (date: YYYY-MM-DD) | "eisenhower_put" (date, eis_do?, eis_schedule?, eis_delegate?, eis_delete? — full replace of that day's grid).
category is one of: business_masters, daily_marketing, daily_seo_task.`,
  {
    action: z.enum(['list', 'get', 'create', 'update', 'delete', 'eisenhower_get', 'eisenhower_put']),
    id: z.string().optional(),
    category: z.enum(['business_masters', 'daily_marketing', 'daily_seo_task']).optional(),
    task_date: z.string().optional().describe('YYYY-MM-DD'),
    source_url: z.string().optional(),
    context: z.string().optional(),
    questions: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
    date: z.string().optional().describe('YYYY-MM-DD, for eisenhower_get/eisenhower_put'),
    eis_do: z.string().optional(),
    eis_schedule: z.string().optional(),
    eis_delegate: z.string().optional(),
    eis_delete: z.string().optional(),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/daily-tasks');
      case 'get': return api('GET', `/api/daily-tasks/${need(a.id, 'id')}`);
      case 'create': return api('POST', '/api/daily-tasks', { category: a.category, task_date: need(a.task_date, 'task_date'), source_url: a.source_url, context: a.context, questions: need(a.questions, 'questions') });
      case 'update': return api('PUT', `/api/daily-tasks/${need(a.id, 'id')}`, { category: a.category, task_date: a.task_date, source_url: a.source_url, context: a.context, questions: a.questions });
      case 'delete': return api('DELETE', `/api/daily-tasks/${need(a.id, 'id')}`);
      case 'eisenhower_get': return api('GET', `/api/eisenhower/${need(a.date, 'date')}`);
      case 'eisenhower_put': return api('PUT', `/api/eisenhower/${need(a.date, 'date')}`, { do: a.eis_do, schedule: a.eis_schedule, delegate: a.eis_delegate, delete: a.eis_delete });
    }
  }
);

// ── workspace_cold_email ──────────────────────────────────────────
defineTool(
  'workspace_cold_email',
  `Cold email reporting, read-only mirror of Instantly (plus a manual trigger to pull fresh data). action: "daily" (days? default 30, max 365 — per-campaign daily rollup) | "accounts" (sending-account warmup health) | "pull" (trigger an immediate re-pull from Instantly, normally runs hourly) | "replies" (limit? default 30, max 100) | "status" (is it configured, last pull attempt/success/error) | "delete_reply" (id — hard delete, dismissing a reply can resurface it on the next pull if Instantly still returns it).`,
  {
    action: z.enum(['daily', 'accounts', 'pull', 'replies', 'status', 'delete_reply']),
    days: z.number().optional(),
    limit: z.number().optional(),
    id: z.string().optional(),
  },
  (a) => {
    switch (a.action) {
      case 'daily': return api('GET', `/api/cold-email/daily${a.days ? '?days=' + a.days : ''}`);
      case 'accounts': return api('GET', '/api/cold-email/accounts');
      case 'pull': return api('POST', '/api/cold-email/pull');
      case 'replies': return api('GET', `/api/cold-email/replies${a.limit ? '?limit=' + a.limit : ''}`);
      case 'status': return api('GET', '/api/cold-email/status');
      case 'delete_reply': return api('DELETE', `/api/replies/${need(a.id, 'id')}`);
    }
  }
);

// ── workspace_calls (call log + SMS + Twilio usage) ───────────────
defineTool(
  'workspace_calls',
  `Call log, SMS, and Twilio account usage. Does not place calls or send live audio — that's browser-SDK-only. action:
"list" (newest 200 calls) | "update" (id, starred?: bool, notes?: string) | "delete" (id, deletes the recording from Twilio too if present) |
"sms_list" (newest 500 messages) | "sms_send" (to, body, lead_id?) | "usage" (Twilio balance + spend today/this month).`,
  {
    action: z.enum(['list', 'update', 'delete', 'sms_list', 'sms_send', 'usage']),
    id: z.string().optional(),
    starred: z.boolean().optional(),
    notes: z.string().optional(),
    to: z.string().optional(),
    body: z.string().optional(),
    lead_id: z.string().optional(),
  },
  (a) => {
    switch (a.action) {
      case 'list': return api('GET', '/api/calls');
      case 'update': return api('PUT', `/api/calls/${need(a.id, 'id')}`, { starred: a.starred, notes: a.notes });
      case 'delete': return api('DELETE', `/api/calls/${need(a.id, 'id')}`);
      case 'sms_list': return api('GET', '/api/sms');
      case 'sms_send': return api('POST', '/api/sms/send', { to: need(a.to, 'to'), body: need(a.body, 'body'), leadId: a.lead_id });
      case 'usage': return api('GET', '/api/twilio/usage');
    }
  }
);

// ── workspace_trash_archive ────────────────────────────────────────
defineTool(
  'workspace_trash_archive',
  `Trash (soft-delete) and Archive (hidden-but-recoverable). action:
"trash_list" | "trash_restore" (type: 'note'|'task'|'reminder', id) | "trash_delete_item" (type, id — permanent) | "trash_empty" (permanently empties all of trash) |
"archive_list" | "archive_restore" (type: 'note'|'task'|'reminder'|'board', id) | "archive_delete" (type, id — for note/task/reminder this moves it to Trash; for board it's a permanent hard delete).`,
  {
    action: z.enum(['trash_list', 'trash_restore', 'trash_delete_item', 'trash_empty', 'archive_list', 'archive_restore', 'archive_delete']),
    type: z.enum(['note', 'task', 'reminder', 'board']).optional(),
    id: z.string().optional(),
  },
  (a) => {
    switch (a.action) {
      case 'trash_list': return api('GET', '/api/trash');
      case 'trash_restore': return api('POST', '/api/trash/restore', { type: need(a.type, 'type'), id: need(a.id, 'id') });
      case 'trash_delete_item': return api('DELETE', '/api/trash/item', { type: need(a.type, 'type'), id: need(a.id, 'id') });
      case 'trash_empty': return api('DELETE', '/api/trash/empty');
      case 'archive_list': return api('GET', '/api/archive');
      case 'archive_restore': return api('POST', '/api/archive/restore', { type: need(a.type, 'type'), id: need(a.id, 'id') });
      case 'archive_delete': return api('POST', '/api/archive/delete', { type: need(a.type, 'type'), id: need(a.id, 'id') });
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
