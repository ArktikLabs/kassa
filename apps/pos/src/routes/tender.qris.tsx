import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { TenderQrisPanel } from "../features/tender-qris/TenderQrisPanel";
import { TenderQrisStaticPanel } from "../features/tender-qris/TenderQrisStaticPanel";
import { useSyncStatus } from "../lib/sync-context.tsx";

type Mode = "dynamic" | "static";

type IsOffline = () => boolean;

const defaultIsOffline: IsOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * KASA-197: `/tender/qris` is the single QRIS entry-point. It auto-routes
 * to the static (printed-QR) panel when the device is offline (`navigator.onLine`
 * false) or the sync runner is parked in `offline` phase, and otherwise
 * defaults to the dynamic (createQRIS) flow. The clerk can flip modes by
 * tapping the header toggle for unstable connections — the manual choice
 * sticks for the rest of the session and the auto-detector only ever
 * re-runs while the toggle is on "auto".
 */
export interface TenderQrisScreenProps {
  /** Test seam: stub `navigator.onLine`. */
  isOffline?: IsOffline;
  /** Test seam: render a specific mode regardless of detection. */
  initialMode?: Mode | "auto";
}

export function TenderQrisScreen({
  isOffline = defaultIsOffline,
  initialMode = "auto",
}: TenderQrisScreenProps = {}) {
  const intl = useIntl();
  const sync = useSyncStatus();

  // `auto` defers to the detector; `dynamic` / `static` are sticky overrides
  // the clerk picks from the toggle.
  const [override, setOverride] = useState<"auto" | Mode>(initialMode);
  const [autoMode, setAutoMode] = useState<Mode>(() => detect(isOffline, sync.phase.kind));

  useEffect(() => {
    if (override !== "auto") return;
    setAutoMode(detect(isOffline, sync.phase.kind));
  }, [isOffline, override, sync.phase.kind]);

  const mode: Mode = override === "auto" ? autoMode : override;

  return (
    <div
      className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-4"
      data-testid="tender-qris-screen"
      data-mode={mode}
      data-mode-source={override === "auto" ? "auto" : "manual"}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-600">
          {mode === "static" ? (
            <FormattedMessage id="tender.qris.mode.static.label" />
          ) : (
            <FormattedMessage id="tender.qris.mode.dynamic.label" />
          )}
        </span>
        <button
          type="button"
          onClick={() => setOverride(mode === "static" ? "dynamic" : "static")}
          data-testid="tender-qris-mode-toggle"
          aria-label={intl.formatMessage({ id: "tender.qris.mode.toggle.aria" })}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-xs font-semibold text-neutral-800 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          {mode === "static" ? (
            <FormattedMessage id="tender.qris.mode.toggle.dynamic" />
          ) : (
            <FormattedMessage id="tender.qris.mode.toggle.static" />
          )}
        </button>
      </div>

      {mode === "static" ? <TenderQrisStaticPanel /> : <TenderQrisPanel />}
    </div>
  );
}

function detect(isOffline: IsOffline, syncPhaseKind: string): Mode {
  if (isOffline()) return "static";
  if (syncPhaseKind === "offline") return "static";
  return "dynamic";
}
