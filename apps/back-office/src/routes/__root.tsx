import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { FormattedMessage } from "react-intl";
import { clearSession, loadSession, roleIsOwner } from "../lib/session";

/*
 * Back-office shell layout — DESIGN-SYSTEM §8 back-office laptop
 * layout (sidebar nav + main content). Header carries the product
 * name and the signed-in staff identity; the sidebar links the six
 * primary CRUD surfaces plus reconciliation.
 */

type NavItem = { to: string; labelId: string; ownerOnly?: boolean };

const NAV: readonly NavItem[] = [
  { to: "/admin/dashboard", labelId: "nav.dashboard" },
  { to: "/admin/sales", labelId: "nav.sales" },
  { to: "/outlets", labelId: "nav.outlets" },
  { to: "/catalog", labelId: "nav.catalog" },
  { to: "/catalog/boms", labelId: "nav.boms" },
  { to: "/staff", labelId: "nav.staff" },
  { to: "/devices", labelId: "nav.devices" },
  { to: "/reports/reconciliation", labelId: "nav.reconciliation" },
  { to: "/admin/reconciliation", labelId: "nav.admin_reconciliation", ownerOnly: true },
  { to: "/settings", labelId: "nav.settings", ownerOnly: true },
];

export function RootLayout() {
  const session = loadSession();
  const router = useRouter();

  const onLogout = () => {
    clearSession();
    void router.navigate({ to: "/login", search: { next: undefined } });
  };

  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3 shadow-sm">
        <Link to="/admin/dashboard" className="text-lg font-bold text-primary-700">
          <FormattedMessage id="app.name" />
        </Link>
        {session ? (
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-neutral-800">{session.displayName}</span>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-neutral-600">
              {session.role}
            </span>
            <button
              type="button"
              onClick={onLogout}
              className="text-sm font-semibold text-primary-700 hover:text-primary-800"
            >
              <FormattedMessage id="nav.logout" />
            </button>
          </div>
        ) : null}
      </header>
      <div className="flex">
        <aside className="hidden w-56 border-r border-neutral-200 bg-white laptop:block">
          <nav className="flex flex-col gap-1 p-4">
            {NAV.filter((item) => !item.ownerOnly || (session && roleIsOwner(session.role))).map(
              (item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="rounded-md px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
                  activeProps={{
                    className:
                      "rounded-md px-3 py-2 text-sm font-semibold text-primary-700 bg-primary-50",
                  }}
                >
                  <FormattedMessage id={item.labelId} />
                </Link>
              ),
            )}
          </nav>
        </aside>
        <main className="flex-1 px-6 py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
