'use strict';
// Renders the same report template used by AUTOMATED_AUDITS/generate_audit.js,
// so Workspace's Audits tab and the local CLI pipeline produce identical output.
const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'audit_template.html'), 'utf8');
const CONFIGS = {
  seo: JSON.parse(fs.readFileSync(path.join(__dirname, 'audit_config.json'), 'utf8')),
  ads: JSON.parse(fs.readFileSync(path.join(__dirname, 'audit_config_ads.json'), 'utf8')),
};

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wraps [FILL IN: ...] style manual-input markers in a colored span so they stand out
// from real content. Runs on already-escaped text, so no raw HTML can sneak in.
function highlightFillins(escapedText) {
  return escapedText.replace(/\[([^\[\]]+)\]/g, '<span class="fillin">[$1]</span>');
}

// Same allowlist as safeUrl() in src/editor.js — duplicated rather than shared because
// that file is a browser ESM bundle entry and this is CommonJS on the server.
// Anything not http(s)/mailto//uploads renders as inert text instead of a link.
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (u.startsWith('/uploads/')) return u;
  // Ad-proof screenshots are embedded inline so they survive outside an authenticated
  // session (exported PDF, a prospect opening the file directly) - image mimetypes only.
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(u)) return u;
  return null;
}

// [FILL IN: ...] is a note to whoever's editing the report, never something a lead
// should see - block the export path while any of these remain unresolved.
function hasUnresolvedFillins(data) {
  return /\[FILL IN:/i.test(JSON.stringify(data));
}

function renderEditBar(blocked) {
  if (blocked) {
    return `<div class="edit-bar edit-bar-blocked no-print">
    <span>Fill in the highlighted numbers before exporting or sending this. Export is disabled until they're replaced.</span>
    <button disabled title="Fill in the highlighted numbers first">Export as PDF</button>
  </div>`;
  }
  return `<div class="edit-bar no-print">
    <span>Click any text to edit it. When it looks right, press <strong>&#8984;P</strong> (or Ctrl+P) and save as PDF.</span>
    <button onclick="window.print()">Export as PDF</button>
  </div>`;
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderHeatmaps(heatmaps, CONFIG) {
  if (!heatmaps || !heatmaps.length) return '';
  const blocks = heatmaps.map(h => {
    const img = safeUrl(h.image);
    const link = safeUrl(h.link);
    const caption = h.caption ? escape(h.caption) : `Where you rank for "${escape(h.keyword)}" across the area`;
    const linkLabel = escape(h.link_label || 'full report');
    return `
    <div class="heatmap-block">
      ${img ? `<img src="${escape(img)}" alt="${escape(h.keyword)}">` : ''}
      <p class="heatmap-caption">${caption}${link ? ` &middot; <a href="${escape(link)}" target="_blank" rel="noopener">${linkLabel}</a>` : ''}</p>
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
  const CONFIG = CONFIGS[data.report_type] || CONFIGS.seo;
  const identity = data.identity || {};
  const narrative = data.narrative || {};

  const findingsRows = (data.findings || []).map(f => `
        <tr>
          <td class="area-cell"><span class="dot ${escape(f.status)}"></span><span contenteditable="true" spellcheck="false">${escape(f.area)}</span></td>
          <td contenteditable="true" spellcheck="false">${highlightFillins(escape(f.finding))}</td>
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
    wiifm_hook: highlightFillins(escape(narrative.wiifm_hook)),
    situation_rows: situationRows,
    findings_rows: findingsRows,
    biggest_opportunity: highlightFillins(escape(narrative.biggest_opportunity)),
    gsc_section: renderGsc(data.gsc),
    heatmap_section: renderHeatmaps(data.heatmaps, CONFIG),
    closing_cta: highlightFillins(escape(narrative.closing_cta || CONFIG.default_closing_cta)),
    edit_bar: renderEditBar(hasUnresolvedFillins(data)),
    report_type_label: CONFIG.report_type_label || 'Local SEO Audit',
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
