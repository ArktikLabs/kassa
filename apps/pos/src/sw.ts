/// <reference lib="webworker" />
/*
 * Service worker for the Kassa POS PWA.
 *
 * Strategy summary (ARCHITECTURE.md §3):
 *  - App shell precache via vite-plugin-pwa's `injectManifest`.
 *  - Catalog images: `CacheFirst`, 30-day TTL, 200-entry LRU.
 *  - `/v1/sales/*` and `/v1/sync/*`: explicit `NetworkOnly` so the
 *    transactional layer (BG-sync queue, IndexedDB outbox) is the only
 *    thing that touches them — never the SW cache.
 *  - Update activation is **message-gated**: the new SW installs and
 *    sits in `waiting` until the window posts `{type: 'SKIP_WAITING'}`,
 *    which the "Update tersedia — muat ulang" toast triggers when the
 *    user accepts. `clientsClaim()` runs unconditionally because it is
 *    a no-op until activation; the toast forces a reload, so the new
 *    SW only ever takes control on a fresh document.
 */

import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { BackgroundSyncPlugin } from "workbox-background-sync";
import { isSkipWaitingMessage } from "./lib/sw-helpers";
import { SALES_QUEUE_NAME, SALES_SUBMIT_PATH } from "./data/sync/push";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("message", (event) => {
  if (isSkipWaitingMessage(event)) {
    self.skipWaiting();
  }
});

clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback. `precacheAndRoute` only matches the exact URLs
// in the precache manifest, so a hard reload of `/enrol` (or any other
// client-side route) while offline would otherwise miss the cache and
// surface as `ERR_INTERNET_DISCONNECTED`. We resolve every same-origin
// navigation against any cache that has `index.html` (the precache cache
// is `workbox-precache-v2-<origin>` but `caches.match` searches all),
// fall through to network when online, and only return a generic 503
// when the document has never been precached.
//
// Hand-rolled rather than `NavigationRoute(createHandlerBoundToURL(...))`
// because the Workbox precache strategy was returning network errors on
// some Playwright `context.setOffline(true)` reloads (KASA-159 root
// cause B post-#84). `caches.match` is an explicit cache lookup with
// no integrity-check / cache-name plumbing in between.
registerRoute(
  ({ request, url }) => {
    if (request.mode !== "navigate") return false;
    const path = url.pathname;
    if (path.startsWith("/v1/") || path.startsWith("/api/")) return false;
    if (path === "/sw.js" || /^\/workbox-.*\.js$/.test(path)) return false;
    return true;
  },
  async ({ request }) => {
    // `ignoreSearch` matters: Workbox stores revisioned precache
    // entries under `<url>?__WB_REVISION__=<hash>` cache keys, so a
    // bare `caches.match("/index.html")` misses without it.
    const indexUrl = new URL("/index.html", self.location.href).href;
    const cached = await caches.match(indexUrl, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch {
      return new Response("Offline — app shell not yet cached.", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
);

// ExpirationPlugin's typed shape conflicts with workbox's WorkboxPlugin
// under `exactOptionalPropertyTypes: true` (every optional field is
// declared `T | undefined` rather than just `T`). The runtime contract
// is correct; widen via `as never` so the strategy options accept it.
const catalogImageExpiration = new ExpirationPlugin({
  maxEntries: 200,
  maxAgeSeconds: 30 * 24 * 60 * 60,
  purgeOnQuotaError: true,
}) as never;

registerRoute(
  ({ request, url }) => request.destination === "image" && url.pathname.startsWith("/v1/catalog/"),
  new CacheFirst({
    cacheName: "kassa-catalog-images-v1",
    plugins: [catalogImageExpiration],
  }),
);

const NETWORK_ONLY = new NetworkOnly();
registerRoute(({ url }) => url.pathname.startsWith("/v1/sync/"), NETWORK_ONLY);

/*
 * Sale pushes are NetworkOnly + `kassa-sales` BackgroundSync queue.
 *
 * The window's push.ts drains the Dexie outbox and drives these POSTs.
 * When the request round-trips normally, Workbox is a no-op and our
 * semantic layer (200/409/5xx/4xx → Dexie status) runs as expected.
 * When the tab is closed mid-flight or the network drops, Workbox
 * clones the request into its own IndexedDB queue and replays it on the
 * next `sync` event (SW activation / connection restore). The server's
 * idempotency on `local_sale_id` makes that replay safe: the next
 * window-side drain reconciles via 409 → `synced`.
 *
 * `maxRetentionTime` is 24h so an overnight outage still recovers.
 */
const salesQueuePlugin = new BackgroundSyncPlugin(SALES_QUEUE_NAME, {
  maxRetentionTime: 24 * 60,
}) as never;
registerRoute(
  ({ url, request }) => request.method === "POST" && url.pathname === SALES_SUBMIT_PATH,
  new NetworkOnly({ plugins: [salesQueuePlugin] }),
  "POST",
);
// Other sales endpoints (GET /v1/sales/:id, POST /v1/sales/:id/void, …)
// are still NetworkOnly but without the retry queue — the outbox owns
// the write-ahead path; reads can safely fail open.
registerRoute(({ url }) => url.pathname.startsWith("/v1/sales/"), NETWORK_ONLY);
