const CACHE_NAME = 'codexweb-shell-v3'
const APP_SHELL_PATHS = ['/', '/manifest.webmanifest']
const STATIC_DESTINATIONS = new Set(['document', 'script', 'style', 'image', 'font'])
const BYPASS_PREFIXES = ['/codex-api/', '/codex-local-image', '/codex-local-file', '/codex-local-browse/', '/codex-local-edit/']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_PATHS)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirstStatic(request))
    return
  }

  if (STATIC_DESTINATIONS.has(request.destination) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(staleWhileRevalidate(request))
  }
})

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME).catch(() => null)
  try {
    const response = await fetch(request)
    if (response.ok) {
      // Cache storage failures must not replace a successful network response.
      await cache?.put('/', response.clone()).catch(() => {})
      return response
    }
    return (await cache?.match('/').catch(() => undefined)) || response
  } catch {
    return (await cache?.match('/').catch(() => undefined)) || Response.error()
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME).catch(() => null)
  const cached = await cache?.match(request).catch(() => undefined)
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache?.put(request, response.clone()).catch(() => {})
      }
      return response
    })
    .catch(() => null)

  if (cached) {
    return cached
  }

  const response = await networkPromise
  return response || Response.error()
}

function isUsableStatic(response, request) {
  if (!response?.ok) return false
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  return request.destination === 'style'
    ? type === 'text/css'
    : ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)
}

async function networkFirstStatic(request) {
  const cache = await caches.open(CACHE_NAME).catch(() => null)
  try {
    const response = await fetch(request)
    if (isUsableStatic(response, request)) {
      await cache?.put(request, response.clone()).catch(() => {})
      return response
    }
  } catch {
    // A network failure may still have a usable copy from an older release.
  }
  const cached = await cache?.match(request).catch(() => undefined)
  return isUsableStatic(cached, request) ? cached : Response.error()
}
