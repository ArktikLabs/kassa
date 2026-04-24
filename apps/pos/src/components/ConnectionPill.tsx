import { FormattedMessage } from "react-intl";

export type ConnectionState = "online" | "syncing" | "offline" | "error";

const STYLES: Record<ConnectionState, { wrap: string; dot: string }> = {
  online: {
    wrap: "bg-success-surface text-success-fg",
    dot: "bg-conn-online",
  },
  syncing: {
    wrap: "bg-info-surface text-info-fg",
    dot: "bg-conn-syncing animate-pulse",
  },
  offline: {
    wrap: "bg-warning-surface text-warning-fg",
    dot: "bg-conn-offline",
  },
  error: {
    wrap: "bg-danger-surface text-danger-fg",
    dot: "bg-conn-error",
  },
};

/*
 * DESIGN-SYSTEM §6.9 — persistent header chip; never collapse on
 * small screens. Always visible. Stub for M2 shell — wire-up to the
 * real online/sync/offline/error machine ships with the sync engine.
 */
export function ConnectionPill({
  state = "online",
  pendingCount = 0,
  onTap,
}: {
  state?: ConnectionState;
  pendingCount?: number;
  onTap?: () => void;
}) {
  const styles = STYLES[state];
  const isTappable = state === "error" && typeof onTap === "function";
  const Tag = isTappable ? "button" : "span";

  return (
    <Tag
      type={isTappable ? "button" : undefined}
      onClick={isTappable ? onTap : undefined}
      role="status"
      aria-live="polite"
      data-state={state}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold ${styles.wrap}`}
    >
      <span className={`h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
      <PillLabel state={state} pendingCount={pendingCount} />
    </Tag>
  );
}

function PillLabel({ state, pendingCount }: { state: ConnectionState; pendingCount: number }) {
  switch (state) {
    case "syncing":
      return <FormattedMessage id="conn.syncing" values={{ count: pendingCount }} />;
    case "offline":
      return <FormattedMessage id="conn.offline" />;
    case "error":
      return <FormattedMessage id="conn.error" />;
    default:
      return <FormattedMessage id="conn.online" />;
  }
}
