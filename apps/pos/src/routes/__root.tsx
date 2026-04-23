import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FormattedMessage } from "react-intl";
import { ConnectionPill } from "../components/ConnectionPill";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col bg-neutral-50 text-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 shadow-sm">
        <Link to="/catalog" className="text-lg font-bold text-primary-700">
          <FormattedMessage id="app.name" />
        </Link>
        <ConnectionPill state="online" />
      </header>
      <main className="flex-1 px-4 py-6">{children}</main>
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
