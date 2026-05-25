const CACHE = 'workspace-v70';
const SHELL = ['/', '/index.html', '/manifest.json', '/app.css?v=80', '/app.js?v=81', '/editor.bundle.js?v=52'];

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

// Page sends message → SW shows notification (bypasses page-context restrictions)
self.addEventListener('message', e => {
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = e.data;
    e.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag,
        renotify: true,
        data: { url: '/' }
      })
    );
  }
});

self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Workspace', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'workspace',
      renotify: true,
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const ws = list.find(c => c.url.includes(self.location.origin));
      if (ws) return ws.focus();
      return clients.openWindow('/');
    })
  );
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
