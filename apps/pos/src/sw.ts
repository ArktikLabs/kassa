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
import { isSkipWaitingMessage } from "./lib/sw-helpers";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("message", (event) => {
  if (isSkipWaitingMessage(event)) {
    self.skipWaiting();
  }
});

clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);

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
  ({ request, url }) =>
    request.destination === "image" &&
    url.pathname.startsWith("/v1/catalog/"),
  new CacheFirst({
    cacheName: "kassa-catalog-images-v1",
    plugins: [catalogImageExpiration],
  }),
);

const NETWORK_ONLY = new NetworkOnly();
registerRoute(
  ({ url }) => url.pathname.startsWith("/v1/sales/"),
  NETWORK_ONLY,
);
registerRoute(
  ({ url }) => url.pathname.startsWith("/v1/sync/"),
  NETWORK_ONLY,
);
