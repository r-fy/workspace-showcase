'use strict';
// Escaping / URL-allowlist / placeholder-substitution checks for audit_render.js.
// Run: node test-audit-render.js
const assert = require('assert');
const { renderAuditHtml } = require('./audit_render');

const html = renderAuditHtml({
  identity: { business_name: 'Acme', city: 'Brea' },
  narrative: { wiifm_hook: '{{closing_cta}}', closing_cta: 'REAL_CTA' },
  current_situation: [
    { label: 'Bad link', value: 'nope', link: 'javascript:alert(1)' },
    { label: 'Good link', value: '"><img src=x onerror=alert(1)>', link: 'https://example.com/x' },
  ],
  findings: [{ status: 'red', area: "O'Brien", finding: 'B' }],
  heatmaps: [{ keyword: 'k', image: 'javascript:alert(1)', link: 'data:text/html,x' }],
});

// Quotes are escaped, so a value can't break out of an HTML attribute.
assert(!html.includes('<img src=x'), 'angle brackets not escaped');
assert(!html.includes('"><img'), 'quote escaping failed — value can break out of an attribute');
assert(html.includes('&quot;&gt;&lt;img'), 'expected escaped situation value');
assert(html.includes('O&#39;Brien'), 'single quote not escaped');

// Unsafe URLs never become href/src.
assert(!html.includes('javascript:'), 'javascript: URL leaked through');
assert(!html.includes('data:text/html'), 'data: URL leaked through');
assert(!/<img[^>]*src="javascript/.test(html), 'unsafe img src leaked');
assert(html.includes('href="https://example.com/x"'), 'safe link should render');

// Single-pass substitution: a field value that looks like a placeholder is left as text.
assert(html.includes('{{closing_cta}}'), 'value was re-substituted (multi-pass bug)');
assert(html.includes('REAL_CTA'), 'closing_cta not substituted');
assert(!html.includes('{{business_name}}'), 'placeholders left unfilled');

console.log('audit_render: all checks passed');
