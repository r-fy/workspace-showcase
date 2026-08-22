#!/usr/bin/env node
// Mac-side helper for the Connections tab. Two modes:
//   report  — run `claude mcp list`, post each server's up/down to the Workspace API (launchd, hourly)
//   warn    — print a one-line warning for anything low/down (Claude Code SessionStart hook)
// Logs in with WORKSPACE_PIN (read from the workspace-app MCP entry in ~/.claude.json
// if not in the env), so no token is stored anywhere.
const { execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const BASE = process.env.WORKSPACE_URL || 'https://workspace.rfisolns.org';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function pin() {
  if (process.env.WORKSPACE_PIN) return process.env.WORKSPACE_PIN;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return cfg.mcpServers?.['workspace-app']?.env?.WORKSPACE_PIN || '';
  } catch { return ''; }
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + '/api' + p, {
    method, headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}`);
  return res.json();
}

async function login() {
  const p = pin(); if (!p) throw new Error('no WORKSPACE_PIN');
  return (await api('POST', '/auth/login', { pin: p })).token;
}

function mcpList() {
  const out = execSync('claude mcp list 2>/dev/null', { encoding: 'utf8', timeout: 120000 });
  const servers = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?): (.+?) - (✔|✘|⚠|·)\s*(.*)$/);
    if (!m) continue;
    const [, name, cmd, mark, rest] = m;
    const kind = /^https?:\/\//.test(cmd) ? (name.startsWith('claude.ai') ? 'claude.ai' : 'remote')
      : name.startsWith('plugin:') ? 'plugin' : 'local';
    servers.push({ name: name.replace(/^claude\.ai /, '').replace(/^plugin:/, ''), kind,
      status: mark === '✔' ? 'up' : 'down', detail: rest.trim() || (mark === '✔' ? 'connected' : 'not connected') });
  }
  return servers;
}

(async () => {
  const mode = process.argv[2] || 'warn';
  const token = await login();
  if (mode === 'report') {
    const servers = mcpList();
    const r = await api('POST', '/connections/mcp', { servers }, token);
    console.log(`reported ${r.count} MCP servers`);
  } else {
    const { rows } = await api('GET', '/connections', null, token);
    const bad = rows.filter(r => r.status === 'low' || r.status === 'down');
    if (bad.length) console.log('Connections warning: ' + bad.map(r =>
      r.status === 'low' ? `${r.name} low ($${r.balance})` : `${r.name} down`).join(', '));
  }
})().catch(e => { if (process.argv[2] === 'report') { console.error(e.message); process.exit(1); } });
