const CACHE = 'workspace-v189';
const SHELL = ['/', '/index.html', '/manifest.json', '/app.css?v=155', '/app.js?v=184', '/editor.bundle.js?v=66', '/dialer.bundle.js?v=1'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API requests: network only, fail gracefully
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// ── Reminder push notifications ──────────────────────────────────────
// The API only accepts the Authorization header (the ws_auth cookie is scoped
// to /uploads), so SW-originated fetches read the credential the page mirrors
// into a tiny dedicated IndexedDB at login (see mirrorAuthForSw in app.js).
function swGetAuth() {
  return new Promise(resolve => {
    const open = indexedDB.open('ws-push', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      const dbi = open.result;
      const tx = dbi.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get('authHeader');
      get.onsuccess = () => { resolve(get.result || null); dbi.close(); };
      get.onerror = () => { resolve(null); dbi.close(); };
    };
    open.onerror = () => resolve(null);
  });
}

// Returns true only when the API accepted the action; false on missing/stale
// auth, offline, or a non-2xx — callers open the app instead of failing silently.
async function swApiPost(path, body) {
  const authHeader = await swGetAuth();
  if (!authHeader) return false; // logged out
  try {
    const res = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function swOpenApp() {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('/');
  });
}

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (err) {}
  // Missed-call/voicemail pushes (v161): plain notification, no reminder
  // action buttons — tapping it just opens the app.
  if (data.type === 'call') {
    e.waitUntil(self.registration.showNotification(data.title || 'Missed call', {
      body: data.body || '',
      tag: 'call-' + Date.now(),
    }));
    return;
  }
  e.waitUntil(self.registration.showNotification(data.title || 'Reminder', {
    body: data.body || '',
    tag: 'reminder-' + (data.id || ''),
    data: { id: data.id },
    // Chrome shows at most 2 action buttons; closing the notification IS
    // "dismiss", so it needs no button of its own.
    actions: [
      { action: 'done', title: '✓ Done' },
      { action: 'snooze', title: 'Snooze 1h' },
    ],
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  if ((e.action === 'done' || e.action === 'snooze') && id) {
    const call = e.action === 'done'
      ? swApiPost('/reminders/' + id + '/complete')
      : swApiPost('/reminders/' + id + '/snooze', { minutes: 60 });
    // If the action couldn't land (locked out, offline, stale auth), open the
    // app so the user sees why instead of the tap silently doing nothing.
    e.waitUntil(call.then(ok => { if (!ok) return swOpenApp(); }).catch(() => swOpenApp()));
  } else {
    e.waitUntil(swOpenApp());
  }
});

self.addEventListener('pushsubscriptionchange', e => {
  // Browser rotated the subscription — re-subscribe with the same key and
  // tell the server (best-effort; the page also re-registers on next open).
  e.waitUntil((async () => {
    try {
      const oldKey = e.oldSubscription && e.oldSubscription.options.applicationServerKey;
      if (!oldKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: oldKey,
      });
      await swApiPost('/push/subscribe', sub.toJSON());
    } catch (err) {}
  })());
});
