import { registerSW } from "virtual:pwa-register";
import { markOfflineReady, markUpdateAvailable } from "./pwaStore";

/*
 * Wires `vite-plugin-pwa`'s registerSW into the app's PWA store.
 *
 * `registerType: 'prompt'` (vite.config.ts) means the new SW installs
 * and waits — `onNeedRefresh` fires, the store flips
 * `updateAvailable`, the toast renders. `updateSW(true)` posts
 * `{type: 'SKIP_WAITING'}` to the waiting worker (which our sw.ts
 * gates on) and reloads the document on `controllerchange`.
 */

export function registerPwa(): void {
  if (typeof window === "undefined") return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      markUpdateAvailable(() => updateSW(true));
    },
    onOfflineReady() {
      markOfflineReady();
    },
  });
}
