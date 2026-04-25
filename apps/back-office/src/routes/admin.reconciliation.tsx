import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { removeUnmatchedStaticTender } from "../data/store";
import { useOutlets, useUnmatchedStaticTenders } from "../data/useStore";
import type { UnmatchedStaticTender } from "../data/types";
import { formatRupiah } from "../lib/format";
import { loadSession, roleIsOwner } from "../lib/session";

/*
 * Manual reconciliation surface for unverified static-QRIS tenders.
 *
 * Renders the per-tender unmatched list described in KASA-64 §static
 * QRIS — the per-outlet variance summary continues to live at
 * `/reports/reconciliation`. Owners use the "Tandai telah diterima"
 * row action to flip a stuck tender to verified by calling the
 * KASA-117 endpoint `POST /v1/admin/reconciliation/match`. Manager and
 * cashier roles can read the list (route guard already restricts to
 * managers+) but the action is owner-only per the parent AC.
 *
 * Data source: scaffold local store (mirrors the rest of the
 * back-office). When the GET endpoint lands the `useUnmatchedStaticTenders`
 * hook becomes a TanStack Query wrapper with the same signature.
 */

const MATCH_ENDPOINT = "/v1/admin/reconciliation/match";
const WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

type AgeBucket = { id: "days" | "hours" | "minutes"; count: number };

function ageBucket(saleAt: string, now: number): AgeBucket {
  const diff = Math.max(0, now - new Date(saleAt).getTime());
  if (diff >= MS_PER_DAY) return { id: "days", count: Math.floor(diff / MS_PER_DAY) };
  if (diff >= MS_PER_HOUR) return { id: "hours", count: Math.floor(diff / MS_PER_HOUR) };
  return { id: "minutes", count: Math.max(1, Math.floor(diff / MS_PER_MINUTE)) };
}

async function postMatch(tenderId: string): Promise<void> {
  const res = await fetch(MATCH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ tenderId, providerTransactionId: null, note: null }),
  });
  if (!res.ok) {
    throw new Error(`match failed: ${res.status}`);
  }
}

export function AdminReconciliationScreen() {
  const intl = useIntl();
  const tenders = useUnmatchedStaticTenders();
  const outlets = useOutlets();
  const session = loadSession();
  const isOwner = !!session && roleIsOwner(session.role);

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const outletById = useMemo(() => new Map(outlets.map((o) => [o.id, o])), [outlets]);

  /* Cap to last 30 days and sort outlet, then businessDate desc, then
   * saleAt asc — so a single outlet's day groups together visually. */
  const visible = useMemo(() => {
    const now = Date.now();
    const cutoff = now - WINDOW_DAYS * MS_PER_DAY;
    return [...tenders]
      .filter((t) => new Date(t.saleAt).getTime() >= cutoff)
      .sort((a, b) => {
        const outletA = outletById.get(a.outletId)?.name ?? a.outletId;
        const outletB = outletById.get(b.outletId)?.name ?? b.outletId;
        if (outletA !== outletB) return outletA.localeCompare(outletB);
        if (a.businessDate !== b.businessDate) return b.businessDate.localeCompare(a.businessDate);
        return a.saleAt.localeCompare(b.saleAt);
      });
  }, [tenders, outletById]);

  const onMatch = async (row: UnmatchedStaticTender) => {
    setErrorId(null);
    setPendingId(row.id);
    try {
      await postMatch(row.id);
      removeUnmatchedStaticTender(row.id);
    } catch {
      setErrorId(row.id);
    } finally {
      setPendingId(null);
    }
  };

  const saleTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }),
    [],
  );

  const now = Date.now();

  const columns: DataTableColumn<UnmatchedStaticTender>[] = [
    {
      key: "outlet",
      header: <FormattedMessage id="admin_reconciliation.col.outlet" />,
      render: (r) => outletById.get(r.outletId)?.name ?? r.outletId,
    },
    {
      key: "business_date",
      header: <FormattedMessage id="admin_reconciliation.col.business_date" />,
      render: (r) => r.businessDate,
    },
    {
      key: "sale_time",
      header: <FormattedMessage id="admin_reconciliation.col.sale_time" />,
      render: (r) => saleTimeFmt.format(new Date(r.saleAt)),
    },
    {
      key: "amount",
      header: <FormattedMessage id="admin_reconciliation.col.amount" />,
      numeric: true,
      render: (r) => formatRupiah(r.amountIdr),
    },
    {
      key: "last4",
      header: <FormattedMessage id="admin_reconciliation.col.last4" />,
      render: (r) => <span className="font-mono tabular-nums">{r.last4}</span>,
    },
    {
      key: "age",
      header: <FormattedMessage id="admin_reconciliation.col.age" />,
      render: (r) => {
        const bucket = ageBucket(r.saleAt, now);
        return (
          <FormattedMessage
            id={`admin_reconciliation.age.${bucket.id}`}
            values={{ count: bucket.count }}
          />
        );
      },
    },
    {
      key: "actions",
      header: <FormattedMessage id="admin_reconciliation.col.actions" />,
      align: "right",
      render: (r) => (
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="primary"
            disabled={!isOwner || pendingId === r.id}
            onClick={() => void onMatch(r)}
            data-testid={`match-button-${r.id}`}
          >
            <FormattedMessage id="admin_reconciliation.action.match" />
          </Button>
          {errorId === r.id ? (
            <span className="text-xs text-danger-fg" role="alert">
              <FormattedMessage id="admin_reconciliation.error" />
            </span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="admin_reconciliation.heading" />
        </h1>
        <p className="text-sm text-neutral-600">
          <FormattedMessage id="admin_reconciliation.subheading" />
        </p>
      </header>

      <DataTable
        rows={visible}
        columns={columns}
        getRowId={(r) => r.id}
        emptyState={<FormattedMessage id="admin_reconciliation.empty" />}
        caption={intl.formatMessage({ id: "admin_reconciliation.heading" })}
      />
    </section>
  );
}
