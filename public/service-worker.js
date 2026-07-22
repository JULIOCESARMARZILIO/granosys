// GranoSYS Mobile — Service Worker v1.0
// PWA offline support + background sync for field operations

const CACHE_NAME = 'granosys-mobile-v1';
const OFFLINE_QUEUE_KEY = 'granosys_offline_queue';

// Static assets to pre-cache for offline use
const STATIC_ASSETS = [
  '/mobile',
  '/mobile.html',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Outfit:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js'
];

// ---- INSTALL: Cache static assets ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache what we can, ignore failures (external CDN may block)
      for (const url of STATIC_ASSETS) {
        try {
          await cache.add(url);
        } catch (e) {
          console.warn('[SW] Could not cache:', url, e.message);
        }
      }
    })
  );
  self.skipWaiting();
});

// ---- ACTIVATE: Clean old caches ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ---- FETCH: Serve from cache, fallback to network ----
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: network-first, queue on failure if POST/PUT
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'POST' || request.method === 'PUT') {
      event.respondWith(networkFirstWithQueue(request));
    } else {
      event.respondWith(networkFirst(request));
    }
    return;
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(request));
});

// Cache-first strategy
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('Offline — recurso no disponible', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// Network-first strategy (for API GETs)
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Sin conexión. Datos no disponibles offline.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Network-first with offline queue (for API POSTs/PUTs)
async function networkFirstWithQueue(request) {
  try {
    const response = await fetch(request.clone());
    return response;
  } catch (e) {
    // Store in IndexedDB offline queue
    await enqueueRequest(request);
    return new Response(
      JSON.stringify({
        queued: true,
        message: 'Sin conexión. La operación fue guardada y se enviará automáticamente cuando recuperes señal.'
      }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// ---- BACKGROUND SYNC: Replay queued requests on reconnect ----
self.addEventListener('sync', (event) => {
  if (event.tag === 'granosys-sync') {
    event.waitUntil(replayQueuedRequests());
  }
});

// Enqueue a failed request in IndexedDB
async function enqueueRequest(request) {
  const body = await request.text();
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2),
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    timestamp: new Date().toISOString()
  };

  // Notify all clients about queued item
  const clients = await self.clients.matchAll();
  clients.forEach((client) =>
    client.postMessage({ type: 'REQUEST_QUEUED', entry })
  );

  // Also store via message to client (IndexedDB managed on client side)
  clients.forEach((client) =>
    client.postMessage({ type: 'ENQUEUE_REQUEST', entry })
  );
}

// Replay queued requests when back online
async function replayQueuedRequests() {
  const clients = await self.clients.matchAll();
  clients.forEach((client) =>
    client.postMessage({ type: 'REPLAY_QUEUE' })
  );
}

// Listen to messages from app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
