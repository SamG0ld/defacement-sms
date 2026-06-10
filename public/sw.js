// Hand-rolled service worker for the Defacement field PWA.
//
// WHY hand-rolled (not Serwist/next-pwa): those assume a webpack build; we run
// Next 16 on Turbopack, where they don't wire in. And the Background Sync API
// can't carry photo bytes and is absent on iOS Safari, so deploy/claim mutations
// are NOT replayed by the SW — they go through the app's own foreground
// IndexedDB outbox (Phase B). This SW's only job is the OFFLINE APP SHELL:
// serve the cached /deploy floor tool and its static assets when the RF floor
// drops the network.
//
// Caching is an ALLOWLIST, not network-first-cache-everything. We persist ONLY:
//   - static assets (/_next/static/*, the precached icons + manifest), and
//   - the /deploy navigation shell (its HTML carries just a user id; the real
//     floor data lives in IndexedDB).
// Every OTHER authenticated navigation (/signs, /activity, /users — bulk PII
// like emails and sign data) is served from the network and NEVER stored, so a
// shared device has no recoverable authed HTML after logout. A non-allowlisted
// navigation that fails offline falls through to the public /offline page.
//
// It never touches: non-GET requests (mutations — owned by the outbox), /api/*
// (auth + freshness), or cross-origin requests (fonts/OAuth — let the network
// handle them). Bump CACHE when the precache list or strategy changes; activate
// prunes old caches — which also retroactively evicts any pre-allowlist cache
// that may hold leaked authed HTML on already-deployed field devices.

const CACHE = "defacement-shell-v2";
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  // Let the page tell a waiting worker to take over immediately (update flow).
  if (event.data === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
  // Sign-out purge: drop the whole shell cache so the next user on a shared
  // device starts clean (the /deploy shell re-warms on the next online visit).
  if (event.data === "PURGE_CACHE") {
    event.waitUntil(caches.delete(CACHE));
  }
});

// Static build output and precached shell assets — safe to persist, non-sensitive.
// Match icon files by exact name / the "/icon-*" raster prefix rather than an open
// "/icon" startsWith, so a future authed route under some "/icon…" path can't
// silently become cacheable.
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === OFFLINE_URL
  );
}

// The ONLY authenticated navigation we persist: the offline floor tool. Its HTML
// body carries just the current user id; all real data is in IndexedDB. Exact
// match — /deploy has no subroutes today; widen this deliberately (and re-check
// that the subroute's HTML is PII-free) if that ever changes.
function isCacheableNavigation(url) {
  return url.pathname === "/deploy";
}

async function networkFirst(request, url) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // Persist only allowlisted, successful, basic (same-origin) responses.
    // Opaque/error responses and all other authed pages are never stored. A
    // /deploy navigation is type:"basic" just like a static asset, so no
    // request.mode distinction is needed on the write path.
    if (
      response.ok &&
      response.type === "basic" &&
      (isStaticAsset(url) || isCacheableNavigation(url))
    ) {
      // Fire-and-forget; a quota/storage failure must never break the response.
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // A navigation with nothing cached: show the offline fallback page.
    if (request.mode === "navigate") {
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
    }
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // mutations: handled by the app outbox
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // third-party: passthrough
  if (url.pathname.startsWith("/api/")) return; // never cache API responses
  event.respondWith(networkFirst(request, url));
});
