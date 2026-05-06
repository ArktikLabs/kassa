/*
 * Sales history (KASA-220).
 *
 * Read-only listing of recent sales for the enrolled outlet, sorted newest
 * first. The clerk taps a row to land on the reprint detail screen. We read
 * straight from the local Dexie outbox: pending, in-flight, and synced rows
 * all surface here because a clerk needs to reprint a receipt the moment a
 * customer asks, even before the server has acknowledged the sale.
 *
 * Sales beyond the local Dexie window — e.g. on a freshly-restored tablet
 * that has no outbox history yet — are out of scope for v0; they can be
 * fetched via `GET /v1/sales` (KASA-122) once a server-backed read path is
 * added in v1.
 */

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import { formatIdr } from "../../shared/money/index.ts";
import { getDatabase, type Database } from "../../data/db/index.ts";
import type { PendingSale, PendingSaleTenderMethod } from "../../data/db/types.ts";
import {
  getSnapshot,
  hydrateEnrolment,
  subscribe,
  type EnrolmentSnapshot,
} from "../../lib/enrolment";

const HISTORY_LIMIT = 50;

export function SaleHistoryScreen() {
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<EnrolmentSnapshot>(
    () => getSnapshot() ?? { state: "loading" },
  );
  const [db, setDb] = useState<Database | null>(null);

  useEffect(() => {
    void hydrateEnrolment();
    return subscribe(setSnapshot);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getDatabase()
      .then((next) => {
        if (!cancelled) setDb(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const outletId = snapshot.state === "enrolled" ? snapshot.device.outlet.id : null;

  const sales = useLiveQuery(async () => {
    if (!db || !outletId) return undefined;
    return db.repos.pendingSales.listRecentByOutlet(outletId, HISTORY_LIMIT);
  }, [db, outletId]);

  if (snapshot.state === "loading") {
    return (
      <section className="space-y-3" aria-busy>
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="receipt.history.loading" />
        </p>
      </section>
    );
  }

  if (snapshot.state !== "enrolled") {
    return (
      <section
        className="space-y-2 rounded-md border border-warning-border bg-warning-surface p-4"
        role="alert"
        data-testid="sales-history-unenrolled"
      >
        <p className="text-sm text-warning-fg">
          <FormattedMessage id="receipt.history.unenrolled" />
        </p>
      </section>
    );
  }

  const ready = sales !== undefined;

  return (
    <section className="space-y-4" aria-label={intl.formatMessage({ id: "receipt.history.aria" })}>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="receipt.history.heading" />
        </h1>
        <p className="text-sm text-neutral-600" data-testid="sales-history-subheading">
          <FormattedMessage
            id="receipt.history.subheading"
            values={{
              outlet: snapshot.device.outlet.name,
              count: ready ? sales.length : 0,
            }}
          />
        </p>
      </header>

      {!ready ? (
        <p className="text-sm text-neutral-500" aria-busy>
          <FormattedMessage id="receipt.history.loading" />
        </p>
      ) : sales.length === 0 ? (
        <section
          className="space-y-2 rounded-md border border-neutral-200 bg-white p-6 text-center"
          data-testid="sales-history-empty"
        >
          <h2 className="text-lg font-semibold text-neutral-900">
            <FormattedMessage id="receipt.history.empty.heading" />
          </h2>
          <p className="text-sm text-neutral-600">
            <FormattedMessage id="receipt.history.empty.body" />
          </p>
        </section>
      ) : (
        <ul
          className="space-y-2"
          data-testid="sales-history-list"
          aria-label={intl.formatMessage({ id: "receipt.history.aria" })}
        >
          {sales.map((sale) => (
            <SaleRow key={sale.localSaleId} sale={sale} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SaleRow({ sale }: { sale: PendingSale }) {
  const intl = useIntl();
  const tenderLabel = describeTender(sale.tenders, intl);
  const createdAtLabel = formatDateTime(sale.createdAt);
  const totalLabel = formatIdr(sale.totalIdr);
  const aria = intl.formatMessage(
    { id: "receipt.history.row.aria" },
    { createdAt: createdAtLabel, total: totalLabel, tender: tenderLabel },
  );

  return (
    <li>
      <Link
        to="/sales/$id"
        params={{ id: sale.localSaleId }}
        className="block rounded-md border border-neutral-200 bg-white p-4 shadow-sm transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        data-testid="sales-history-row"
        data-local-sale-id={sale.localSaleId}
        aria-label={aria}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold text-neutral-900" data-testid="row-created-at">
            {createdAtLabel}
          </span>
          <span className="font-mono tabular-nums text-base font-bold text-neutral-900">
            {totalLabel}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-neutral-600">
          <span data-testid="row-tender">{tenderLabel}</span>
          <StatusBadge status={sale.status} />
        </div>
      </Link>
    </li>
  );
}

function StatusBadge({ status }: { status: PendingSale["status"] }) {
  const tone = STATUS_TONES[status];
  return (
    <span
      className={[
        "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        tone,
      ].join(" ")}
      data-testid="row-status"
      data-status={status}
    >
      <FormattedMessage id={`receipt.history.status.${status}`} />
    </span>
  );
}

const STATUS_TONES: Record<PendingSale["status"], string> = {
  queued: "border-neutral-300 bg-neutral-100 text-neutral-700",
  sending: "border-neutral-300 bg-neutral-100 text-neutral-700",
  error: "border-warning-border bg-warning-surface text-warning-fg",
  needs_attention: "border-danger-border bg-danger-surface text-danger-fg",
  synced: "border-success-border bg-success-surface text-success-fg",
};

const TENDER_LABEL_IDS: Record<PendingSaleTenderMethod, string> = {
  cash: "receipt.history.row.tender.cash",
  qris: "receipt.history.row.tender.qris",
  qris_static: "receipt.history.row.tender.qris_static",
  card: "receipt.history.row.tender.card",
  other: "receipt.history.row.tender.other",
};

function describeTender(tenders: PendingSale["tenders"], intl: ReturnType<typeof useIntl>): string {
  if (tenders.length === 0) {
    return intl.formatMessage({ id: "receipt.history.row.tender.other" });
  }
  const methods = new Set(tenders.map((t) => t.method));
  if (methods.size > 1) {
    return intl.formatMessage({ id: "receipt.history.row.tender.mixed" });
  }
  const method = tenders[0]!.method;
  return intl.formatMessage({ id: TENDER_LABEL_IDS[method] });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}
