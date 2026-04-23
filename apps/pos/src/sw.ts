/// <reference lib="webworker" />
/*
 * Service worker source consumed by vite-plugin-pwa's injectManifest
 * strategy. At build time, `self.__WB_MANIFEST` is replaced with the
 * precache manifest. Runtime caching strategies (catalog images,
 * allow-listed GET /api reads) live here and expand as the PWA grows
 * — see TECH-STACK.md §3.8.
 */

import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
