import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FormattedMessage } from "react-intl";
import { ConnectionPill, type ConnectionState } from "../components/ConnectionPill";
import { ToastViewport } from "../components/Toast";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { useSyncActions, useSyncStatus } from "../lib/sync-provider";
import type { SyncPhase } from "../data/sync/index.ts";

function mapPhase(
  phase: SyncPhase,
  needsAttentionCount: number,
): { state: ConnectionState; pendingCount: number } {
  // A non-empty `needs_attention` backlog means the clerk has work to do
  // in /admin. Surface that over "online" so the chip is actionable even
  // when the drain is otherwise idle. (DESIGN-SYSTEM §6.9.)
  if (needsAttentionCount > 0 && phase.kind !== "syncing" && phase.kind !== "offline") {
    return { state: "error", pendingCount: needsAttentionCount };
  }
  switch (phase.kind) {
    case "syncing":
      return { state: "syncing", pendingCount: phase.pending };
    case "offline":
      return { state: "offline", pendingCount: 0 };
    case "error":
      return { state: "error", pendingCount: needsAttentionCount };
    default:
      return { state: "online", pendingCount: 0 };
  }
}

export function RootLayout({ children }: { children: ReactNode }) {
  const status = useSyncStatus();
  const { triggerRefresh } = useSyncActions();
  const { state, pendingCount } = mapPhase(status.phase, status.needsAttentionCount);
  return (
    <div className="min-h-dvh flex flex-col bg-neutral-50 text-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 shadow-sm">
        <Link to="/catalog" className="text-lg font-bold text-primary-700">
          <FormattedMessage id="app.name" />
        </Link>
        <ConnectionPill
          state={state}
          pendingCount={pendingCount}
          onTap={() => {
            void triggerRefresh();
          }}
        />
      </header>
      <main className="flex-1 px-4 py-6">{children}</main>
      <UpdatePrompt />
      {/*
       * `/enrol` is intentionally not surfaced in the nav: once the device is
       * enrolled the route redirects to `/catalog`, and the reset flow routes
       * the clerk back via `/admin`. `/eod` lands next to `/admin` for the
       * clerk's end-of-day ritual (KASA-65).
       */}
      <nav className="grid grid-cols-5 border-t border-neutral-200 bg-white text-[12px] font-semibold text-neutral-600">
        <NavItem to="/catalog" labelId="nav.catalog" />
        <NavItem to="/cart" labelId="nav.cart" />
        <NavItem to="/tender/cash" labelId="nav.tender.cash" />
        <NavItem to="/eod" labelId="nav.eod" />
        <NavItem to="/admin" labelId="nav.admin" />
      </nav>
      <ToastViewport />
    </div>
  );
}

function NavItem({ to, labelId }: { to: string; labelId: string }) {
  return (
    <Link
      to={to}
      className="py-3 text-center transition-colors hover:bg-neutral-100"
      activeProps={{ className: "text-primary-700 bg-primary-50" }}
    >
      <FormattedMessage id={labelId} />
    </Link>
  );
}
