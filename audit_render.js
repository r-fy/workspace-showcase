'use strict';
// Renders the same report template used by AUTOMATED_AUDITS/generate_audit.js,
// so Workspace's Audits tab and the local CLI pipeline produce identical output.
const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'audit_template.html'), 'utf8');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit_config.json'), 'utf8'));

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same allowlist as safeUrl() in src/editor.js — duplicated rather than shared because
// that file is a browser ESM bundle entry and this is CommonJS on the server.
// Anything not http(s)/mailto//uploads renders as inert text instead of a link.
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith('/uploads/')) return u;
  return null;
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderHeatmaps(heatmaps) {
  if (!heatmaps || !heatmaps.length) return '';
  const blocks = heatmaps.map(h => {
    const img = safeUrl(h.image);
    const link = safeUrl(h.link);
    return `
    <div class="heatmap-block">
      ${img ? `<img src="${escape(img)}" alt="Ranking heatmap for ${escape(h.keyword)}">` : ''}
      <p class="heatmap-caption">Where you rank for "${escape(h.keyword)}" across the area${link ? ` &middot; <a href="${escape(link)}" target="_blank" rel="noopener">full report</a>` : ''}</p>
    </div>`;
  }).join('');
  return `<h2>${escape(CONFIG.heatmap_section_title || 'Where you rank across the map')}</h2>${blocks}`;
}

function renderGsc(gsc) {
  if (!gsc || !gsc.available) return '';
  const rows = (gsc.top_queries || []).map(q =>
    `<tr><td>${escape(q.query)}</td><td>${escape(q.clicks)}</td><td>${escape(q.position)}</td></tr>`
  ).join('');
  return `
    <h2>Search Console data</h2>
    <table class="situation">
      <thead><tr><td>Query</td><td>Clicks</td><td>Avg position</td></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="gsc-note">${escape(gsc.notes || '')}</p>`;
}

// data matches AUTOMATED_AUDITS/input_template.json shape: identity, current_situation,
// findings, heatmaps, gsc, narrative.
function renderAuditHtml(data) {
  const identity = data.identity || {};
  const narrative = data.narrative || {};

  const findingsRows = (data.findings || []).map(f => `
        <tr>
          <td class="area-cell"><span class="dot ${escape(f.status)}"></span><span contenteditable="true" spellcheck="false">${escape(f.area)}</span></td>
          <td contenteditable="true" spellcheck="false">${escape(f.finding)}</td>
        </tr>`).join('');

  const situationRows = (data.current_situation || []).map(r => {
    const link = safeUrl(r.link);
    const value = link
      ? `<a href="${escape(link)}" target="_blank" rel="noopener" contenteditable="true" spellcheck="false">${escape(r.value)}</a>`
      : `<span contenteditable="true" spellcheck="false">${escape(r.value)}</span>`;
    return `<tr><td contenteditable="true" spellcheck="false">${escape(r.label)}</td><td>${value}</td></tr>`;
  }).join('\n      ');

  const fields = {
    business_name: identity.business_name,
    city: identity.city,
    date: data.date || todayStr(),
    wiifm_hook: narrative.wiifm_hook,
    situation_rows: situationRows,
    findings_rows: findingsRows,
    biggest_opportunity: narrative.biggest_opportunity,
    gsc_section: renderGsc(data.gsc),
    heatmap_section: renderHeatmaps(data.heatmaps),
    closing_cta: narrative.closing_cta || CONFIG.default_closing_cta,
    section_1_title: CONFIG.section_1_title,
    section_2_title: CONFIG.section_2_title,
    biggest_opportunity_title: CONFIG.biggest_opportunity_title,
    color_accent: CONFIG.colors.accent,
    color_hook_bg: CONFIG.colors.hook_bg,
    color_hook_border: CONFIG.colors.hook_border,
    color_callout_bg: CONFIG.colors.callout_bg,
    color_callout_border: CONFIG.colors.callout_border,
    color_dot_red: CONFIG.colors.dot_red,
    color_dot_yellow: CONFIG.colors.dot_yellow,
    color_dot_green: CONFIG.colors.dot_green,
  };

  // Single pass: a value that itself contains "{{other_field}}" can't be re-substituted,
  // and an unknown placeholder is left alone rather than half-replaced.
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.hasOwn(fields, key) ? String(fields[key] ?? '') : m);
}

module.exports = { renderAuditHtml };
