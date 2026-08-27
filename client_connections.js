'use strict';
// Per-lead connection sources: on-demand pulls of live client data (GBP, GSC,
// GA4, Bing, WordPress, DataForSEO), separate from connections.js (which is
// account-wide API health, not client data). Each source declares the secret
// fields it needs (stored per-lead in the lead_secrets table, never in git or
// this file) and a pull(secrets, config) that returns { status, data, detail }.
// status: 'up' | 'down'. data is a flat object of label->value shown as cards.

const crypto = require('crypto');

const TIMEOUT_MS = 15000;

async function req(url, opts = {}) {
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

// RS256-sign a Google service-account JWT and exchange it for an access token.
// Hand-rolled with Node's own crypto module — no google-auth-library dependency
// for what is, underneath, one signed POST.
async function googleServiceAccountToken(serviceAccountJson, scope) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const nowS = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token',
    exp: nowS + 3600, iat: nowS,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key).toString('base64url');
  const jwt = `${unsigned}.${sig}`;
  const r = await req('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok || !r.json?.access_token) throw new Error(r.json?.error_description || `token exchange failed: HTTP ${r.status}`);
  return r.json.access_token;
}

// Exchange a stored OAuth refresh_token (GBP uses installed-app OAuth, not a
// service account) for a fresh access token.
async function googleRefreshToken(clientId, clientSecret, refreshToken) {
  const r = await req('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  if (!r.ok || !r.json?.access_token) throw new Error(r.json?.error_description || `token refresh failed: HTTP ${r.status}`);
  return r.json.access_token;
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

const SOURCES = [
  {
    id: 'gbp', name: 'Google Business Profile', covers: 'directions, calls, clicks',
    fields: [
      { key: 'client_id', label: 'OAuth client ID' },
      { key: 'client_secret', label: 'OAuth client secret', secret: true },
      { key: 'refresh_token', label: 'Refresh token', secret: true },
      { key: 'location_id', label: 'Location ID (locations/NNNN...)' },
    ],
    async pull(s) {
      const token = await googleRefreshToken(s.client_id, s.client_secret, s.refresh_token);
      const loc = s.location_id.replace(/^locations\//, '');
      const params = new URLSearchParams();
      ['BUSINESS_DIRECTION_REQUESTS', 'CALL_CLICKS', 'WEBSITE_CLICKS'].forEach(m => params.append('dailyMetrics', m));
      const range = { start_date: daysAgoISO(7), end_date: daysAgoISO(0) };
      // fetchMultiDailyMetricsTimeSeries wants a flat query-param date range.
      const [sy, sm, sd] = range.start_date.split('-'); const [ey, em, ed] = range.end_date.split('-');
      params.set('dailyRange.start_date.year', sy); params.set('dailyRange.start_date.month', String(+sm));
      params.set('dailyRange.start_date.day', String(+sd));
      params.set('dailyRange.end_date.year', ey); params.set('dailyRange.end_date.month', String(+em));
      params.set('dailyRange.end_date.day', String(+ed));
      const r = await req(`https://businessprofileperformance.googleapis.com/v1/locations/${loc}:fetchMultiDailyMetricsTimeSeries?${params}`,
        { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return { status: 'down', detail: r.json?.error?.message || `HTTP ${r.status}` };
      const sums = {};
      for (const series of r.json?.multiDailyMetricTimeSeries?.[0]?.dailyMetricTimeSeries || []) {
        const total = (series.timeSeries?.datedValues || []).reduce((a, v) => a + Number(v.value || 0), 0);
        sums[series.dailyMetric] = total;
      }
      return {
        status: 'up', detail: 'last 7 days',
        data: {
          'direction requests (7d)': sums.BUSINESS_DIRECTION_REQUESTS ?? 0,
          'call clicks (7d)': sums.CALL_CLICKS ?? 0,
          'website clicks (7d)': sums.WEBSITE_CLICKS ?? 0,
        },
      };
    },
  },
  {
    id: 'gsc', name: 'Search Console', covers: 'indexing, sitemaps, query performance',
    fields: [
      { key: 'service_account_json', label: 'Service account JSON', secret: true, multiline: true },
      { key: 'site_url', label: 'Property (e.g. https://example.com/)' },
    ],
    async pull(s) {
      const token = await googleServiceAccountToken(s.service_account_json, 'https://www.googleapis.com/auth/webmasters.readonly');
      const site = encodeURIComponent(s.site_url);
      const [perf, sitemaps] = await Promise.all([
        req(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate: daysAgoISO(28), endDate: daysAgoISO(1), dimensions: [] }),
        }),
        req(`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`, { headers: { Authorization: 'Bearer ' + token } }),
      ]);
      if (!perf.ok) return { status: 'down', detail: perf.json?.error?.message || `HTTP ${perf.status}` };
      const row = perf.json?.rows?.[0] || {};
      let submitted = 0, indexed = 0;
      for (const sm of sitemaps.json?.sitemap || []) {
        for (const c of sm.contents || []) { submitted += Number(c.submitted || 0); indexed += Number(c.indexed || 0); }
      }
      return {
        status: 'up', detail: 'last 28 days',
        data: {
          'clicks (28d)': Math.round(row.clicks || 0),
          'impressions (28d)': Math.round(row.impressions || 0),
          'avg position': row.position ? row.position.toFixed(1) : 'n/a',
          'indexed URLs': sitemaps.ok ? `${indexed} / ${submitted}` : 'n/a',
        },
      };
    },
  },
  {
    id: 'ga4', name: 'Google Analytics 4', covers: 'sessions by channel, conversions',
    fields: [
      { key: 'service_account_json', label: 'Service account JSON', secret: true, multiline: true },
      { key: 'property_id', label: 'GA4 property ID (numbers only)' },
    ],
    async pull(s) {
      const token = await googleServiceAccountToken(s.service_account_json, 'https://www.googleapis.com/auth/analytics.readonly');
      const r = await req(`https://analyticsdata.googleapis.com/v1beta/properties/${s.property_id}:runReport`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'conversions' }],
        }),
      });
      if (!r.ok) return { status: 'down', detail: r.json?.error?.message || `HTTP ${r.status}` };
      const rows = r.json?.rows || [];
      const totalSessions = rows.reduce((a, row) => a + Number(row.metricValues[0].value), 0);
      const totalConv = rows.reduce((a, row) => a + Number(row.metricValues[1].value), 0);
      const organic = rows.find(row => /organic/i.test(row.dimensionValues[0].value));
      return {
        status: 'up', detail: 'last 28 days',
        data: {
          'sessions (28d)': totalSessions,
          'organic sessions (28d)': organic ? Number(organic.metricValues[0].value) : 0,
          'conversions (28d)': totalConv,
          'channels reported': rows.length,
        },
      };
    },
  },
  {
    id: 'bing', name: 'Bing Webmaster', covers: 'rank, traffic, crawl stats',
    fields: [
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'site_url', label: 'Site (e.g. https://example.com/)' },
    ],
    async pull(s) {
      const site = encodeURIComponent(s.site_url);
      const r = await req(`https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?siteUrl=${site}&apikey=${s.api_key}`);
      if (!r.ok) return { status: 'down', detail: `HTTP ${r.status}` };
      const rows = r.json?.d || [];
      const latest = rows[rows.length - 1] || {};
      return {
        status: 'up', detail: 'most recent Bing period',
        data: {
          clicks: latest.Clicks ?? 'n/a',
          impressions: latest.Impressions ?? 'n/a',
          'avg position': latest.AvgClickPosition ?? 'n/a',
          'avg impression position': latest.AvgImpressionPosition ?? 'n/a',
        },
      };
    },
  },
  {
    id: 'wordpress', name: 'WordPress REST API', covers: 'live page content, meta, schema',
    fields: [
      { key: 'site_url', label: 'Site URL (e.g. https://example.com)' },
      { key: 'username', label: 'Username' },
      { key: 'app_password', label: 'Application password', secret: true },
    ],
    async pull(s) {
      const base = s.site_url.replace(/\/+$/, '');
      const auth = 'Basic ' + Buffer.from(`${s.username}:${s.app_password}`).toString('base64');
      const r = await req(`${base}/wp-json/wp/v2/users/me`, { headers: { Authorization: auth } });
      if (!r.ok) return { status: 'down', detail: r.json?.message || `HTTP ${r.status}` };
      return {
        status: 'up', detail: 'auth confirmed',
        data: { 'logged in as': r.json?.name || s.username, site: base.replace(/^https?:\/\//, '') },
      };
    },
  },
  {
    id: 'dataforseo', name: 'DataForSEO', covers: 'rank check, keyword volume, AI Overview',
    fields: [
      { key: 'domain', label: 'Domain (e.g. example.com)' },
      { key: 'keyword', label: 'Keyword to check' },
      { key: 'location_coordinate', label: 'lat,long (e.g. 33.9166,-117.9000)' },
    ],
    // Reuses the account-wide DATAFORSEO_LOGIN/PASSWORD from connections.js's
    // env — this is one paid account, not a per-client credential.
    async pull(s, env) {
      if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return { status: 'down', detail: 'DATAFORSEO_LOGIN/PASSWORD not set on the server' };
      const auth = 'Basic ' + Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64');
      const r = await req('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          keyword: s.keyword, location_coordinate: s.location_coordinate, language_code: 'en',
          device: 'mobile', load_async_ai_overview: true,
        }]),
      });
      const result = r.json?.tasks?.[0]?.result?.[0];
      if (!r.ok || !result) return { status: 'down', detail: r.json?.tasks?.[0]?.status_message || `HTTP ${r.status}` };
      const items = result.items || [];
      const organicRank = items.find(it => it.type === 'organic' && (it.domain || '').includes(s.domain))?.rank_absolute;
      const aiOverview = items.find(it => it.type === 'ai_overview');
      const aiMentions = aiOverview ? JSON.stringify(aiOverview).includes(s.domain) : false;
      return {
        status: 'up', detail: `"${s.keyword}" at ${s.location_coordinate}`,
        data: {
          'organic rank': organicRank ?? 'not in top results',
          'AI Overview present': aiOverview ? 'yes' : 'no',
          'AI Overview mentions domain': aiOverview ? (aiMentions ? 'yes' : 'no') : 'n/a',
        },
      };
    },
  },
];

module.exports = { SOURCES };
