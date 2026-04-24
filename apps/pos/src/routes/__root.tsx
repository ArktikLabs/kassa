import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FormattedMessage } from "react-intl";
import { ConnectionPill, type ConnectionState } from "../components/ConnectionPill";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { useSyncActions, useSyncStatus } from "../lib/sync-provider";
import type { SyncPhase } from "../data/sync/index.ts";

function mapPhase(phase: SyncPhase): { state: ConnectionState; pendingCount: number } {
  switch (phase.kind) {
    case "syncing":
      return { state: "syncing", pendingCount: phase.pending };
    case "offline":
      return { state: "offline", pendingCount: 0 };
    case "error":
      return { state: "error", pendingCount: 0 };
    case "idle":
    default:
      return { state: "online", pendingCount: 0 };
  }
}

export function RootLayout({ children }: { children: ReactNode }) {
  const status = useSyncStatus();
  const { triggerRefresh } = useSyncActions();
  const { state, pendingCount } = mapPhase(status.phase);
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
      <nav className="grid grid-cols-5 border-t border-neutral-200 bg-white text-[12px] font-semibold text-neutral-600">
        <NavItem to="/catalog" labelId="nav.catalog" />
        <NavItem to="/cart" labelId="nav.cart" />
        <NavItem to="/tender/cash" labelId="nav.tender.cash" />
        <NavItem to="/enrol" labelId="nav.enrol" />
        <NavItem to="/admin" labelId="nav.admin" />
      </nav>
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
