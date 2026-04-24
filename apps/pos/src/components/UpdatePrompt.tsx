import { FormattedMessage } from "react-intl";
import {
  acceptUpdate,
  dismissOfflineReady,
  usePwaState,
} from "../lib/pwaStore";

/*
 * DESIGN-SYSTEM §6.11 — toast container for the two PWA lifecycle
 * notifications. Bottom-center on POS, leading-status colour, action
 * variant ("Update tersedia") is persistent until the user accepts;
 * info variant ("Siap untuk dipakai offline") is dismissible.
 */

export function UpdatePrompt() {
  const { updateAvailable, offlineReady } = usePwaState();

  if (!updateAvailable && !offlineReady) return null;

  return (
    <div
      role="region"
      aria-label="Notifikasi pembaruan aplikasi"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {offlineReady && <OfflineReadyToast />}
      {updateAvailable && <UpdateAvailableToast />}
    </div>
  );
}

function UpdateAvailableToast() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pwa-update-toast"
      className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-md border border-info-border bg-info-surface px-4 py-3 text-info-fg shadow-md"
    >
      <span className="text-sm font-semibold">
        <FormattedMessage id="pwa.updateAvailable" />
      </span>
      <button
        type="button"
        onClick={acceptUpdate}
        className="rounded-md bg-info-solid px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-info-fg"
      >
        <FormattedMessage id="pwa.updateAccept" />
      </button>
    </div>
  );
}

function OfflineReadyToast() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pwa-offline-ready-toast"
      className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-md border border-success-border bg-success-surface px-4 py-3 text-success-fg shadow-md"
    >
      <span className="text-sm font-semibold">
        <FormattedMessage id="pwa.offlineReady" />
      </span>
      <button
        type="button"
        onClick={dismissOfflineReady}
        aria-label="Tutup"
        className="rounded-md px-2 py-1 text-sm font-semibold transition-colors hover:bg-success-border"
      >
        ×
      </button>
    </div>
  );
}
