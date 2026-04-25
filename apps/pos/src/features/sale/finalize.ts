import { toRupiah, type Rupiah } from "../../shared/money/index.ts";
import type { Database } from "../../data/db/index.ts";
import type { Item, PendingSale, PendingSaleItem, PendingSaleTender } from "../../data/db/types.ts";
import { uuidv7 } from "../../lib/uuidv7.ts";
import type { CartLine, CartTotals } from "../cart/types.ts";
import { explodeLines } from "../stock/index.ts";
import { kassaSale, type KassaSale } from "./schema.ts";

/*
 * `features/sale.finalize` turns a filled cart + cash tender into a persisted
 * pending_sale row and a matching optimistic stock decrement — all inside one
 * Dexie transaction so the outbox and the on-hand view never disagree. The
 * KassaSale Zod schema is the last line of defence before anything reaches
 * the IndexedDB outbox; a parse failure throws and the UI keeps the cart
 * intact for the clerk to retry.
 *
 * ARCHITECTURE.md §3.1 Flow B + ADR-004 (client-generated UUIDv7 idempotency key).
 */

export class SaleFinalizeError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SaleFinalizeError";
  }
}

export interface FinalizeCashInput {
  lines: readonly CartLine[];
  totals: CartTotals;
  /** Cash actually handed over by the customer. Must be ≥ totals.totalIdr. */
  tenderedIdr: Rupiah;
}

export interface FinalizeQrisInput {
  lines: readonly CartLine[];
  totals: CartTotals;
  /**
   * The client-generated UUIDv7 passed to `POST /v1/payments/qris` — we use
   * the same id as both `localSaleId` and the Midtrans `order_id` so the
   * tender row and the outbox row reconcile 1:1 by primary key.
   */
  localSaleId: string;
  /**
   * The Midtrans order id the webhook will carry. In our current wiring this
   * equals `localSaleId`, but the field is carried through verbatim so that
   * a future provider that mints its own id still reconciles.
   */
  qrisOrderId: string;
}

export interface FinalizeQrisStaticInput {
  lines: readonly CartLine[];
  totals: CartTotals;
  /**
   * Last 4 digits of the buyer's QRIS reference, captured by the clerk on
   * the static-QRIS panel. The reconciliation matcher (KASA-64 server side)
   * keys on `last4 + amount + outlet + ±10-min window`.
   */
  buyerRefLast4: string;
}

export interface FinalizeContext {
  database: Database;
  /** Injected for tests. Defaults to `uuidv7()`. */
  generateLocalSaleId?: () => string;
  /** Injected for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface FinalizeResult {
  localSaleId: string;
  sale: KassaSale;
  pendingSale: PendingSale;
  changeDueIdr: Rupiah;
}

function toBusinessDate(now: Date, timezone: string | undefined): string {
  // en-CA formats as YYYY-MM-DD; we only borrow the format, not the locale.
  // Merchant-local business date, not UTC — clerks close the day on the
  // outlet's clock.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function buildSaleItems(
  lines: readonly CartLine[],
  itemById: Map<string, Item>,
): PendingSaleItem[] {
  return lines.map((line) => {
    const item = itemById.get(line.itemId);
    if (!item) {
      throw new SaleFinalizeError(`item ${line.itemId} not found in catalog`);
    }
    return {
      itemId: line.itemId,
      bomId: item.bomId,
      quantity: line.quantity,
      uomId: item.uomId,
      unitPriceIdr: line.unitPriceIdr,
      lineTotalIdr: line.lineTotalIdr,
    };
  });
}

export async function finalizeCashSale(
  input: FinalizeCashInput,
  ctx: FinalizeContext,
): Promise<FinalizeResult> {
  const { database } = ctx;
  const genId = ctx.generateLocalSaleId ?? uuidv7;
  const now = ctx.now?.() ?? new Date();

  if (input.lines.length === 0) {
    throw new SaleFinalizeError("cart is empty");
  }
  if ((input.tenderedIdr as number) < (input.totals.totalIdr as number)) {
    throw new SaleFinalizeError("tendered amount is less than the total");
  }

  const deviceSecret = await database.repos.deviceSecret.get();
  if (!deviceSecret) {
    throw new SaleFinalizeError("device is not enrolled");
  }
  const outlet = await database.repos.outlets.getById(deviceSecret.outletId);

  const businessDate = toBusinessDate(now, outlet?.timezone);
  const localSaleId = genId();
  const createdAtIso = now.toISOString();

  const items = await Promise.all(
    input.lines.map(async (line) => {
      const item = await database.repos.items.getById(line.itemId);
      return [line.itemId, item] as const;
    }),
  );
  const itemById = new Map<string, Item>();
  for (const [id, item] of items) {
    if (item) itemById.set(id, item);
  }

  const saleItems = buildSaleItems(input.lines, itemById);
  const tenders: PendingSaleTender[] = [
    {
      method: "cash",
      amountIdr: input.tenderedIdr,
      reference: null,
    },
  ];

  const sale: KassaSale = kassaSale.parse({
    localSaleId,
    outletId: deviceSecret.outletId,
    clerkId: deviceSecret.deviceId,
    businessDate,
    createdAt: createdAtIso,
    subtotalIdr: input.totals.subtotalIdr as number,
    discountIdr: input.totals.discountIdr as number,
    totalIdr: input.totals.totalIdr as number,
    items: saleItems,
    tenders,
  });

  // Resolve BOM explosion outside the rw-tx: boms table is read-only here and
  // the resolved list is deterministic w.r.t. the cart + catalog snapshot we
  // already fetched. Keeping the boms read off the rw-tx lets Dexie scope the
  // transaction to (pending_sales, stock_snapshot) — fewer locks, same atomicity.
  const stockMoves = await explodeLines(
    database,
    input.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    itemById,
  );

  // Single rw-transaction: enqueue outbox row AND decrement each exploded
  // stock row. Either both succeed or neither does — Dexie aborts the tx on
  // throw. BOM-backed items decrement components, not the finished good.
  const pendingSale: PendingSale = await database.db.transaction(
    "rw",
    database.db.pending_sales,
    database.db.stock_snapshot,
    async () => {
      const row: PendingSale = {
        localSaleId: sale.localSaleId,
        outletId: sale.outletId,
        clerkId: sale.clerkId,
        businessDate: sale.businessDate,
        createdAt: sale.createdAt,
        subtotalIdr: toRupiah(sale.subtotalIdr),
        discountIdr: toRupiah(sale.discountIdr),
        totalIdr: toRupiah(sale.totalIdr),
        items: saleItems.map((line) => ({
          ...line,
          unitPriceIdr: toRupiah(line.unitPriceIdr),
          lineTotalIdr: toRupiah(line.lineTotalIdr),
        })),
        tenders: tenders.map((t) => ({
          ...t,
          amountIdr: toRupiah(t.amountIdr),
        })),
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        serverSaleName: null,
      };
      await database.db.pending_sales.put(row);

      for (const move of stockMoves) {
        await database.repos.stockSnapshot.applyOptimisticDelta(
          sale.outletId,
          move.itemId,
          -move.quantity,
          createdAtIso,
        );
      }
      return row;
    },
  );

  return {
    localSaleId: sale.localSaleId,
    sale,
    pendingSale,
    changeDueIdr: toRupiah((input.tenderedIdr as number) - (input.totals.totalIdr as number)),
  };
}

/**
 * Finalise a cart as a QRIS-tendered sale. Called by the QRIS tender panel
 * after `GET /v1/payments/qris/:orderId/status` returns `paid`. The sale is
 * enqueued to the outbox with `tenders[0].method = "qris"` and
 * `tenders[0].reference = qrisOrderId` so the server-side sync can
 * reconcile it against the Midtrans webhook state.
 *
 * QRIS cannot leave change due, so `changeDueIdr` is always zero.
 */
export async function finalizeQrisSale(
  input: FinalizeQrisInput,
  ctx: FinalizeContext,
): Promise<FinalizeResult> {
  const { database } = ctx;
  const now = ctx.now?.() ?? new Date();

  if (input.lines.length === 0) {
    throw new SaleFinalizeError("cart is empty");
  }

  const deviceSecret = await database.repos.deviceSecret.get();
  if (!deviceSecret) {
    throw new SaleFinalizeError("device is not enrolled");
  }
  const outlet = await database.repos.outlets.getById(deviceSecret.outletId);

  const businessDate = toBusinessDate(now, outlet?.timezone);
  const createdAtIso = now.toISOString();

  const items = await Promise.all(
    input.lines.map(async (line) => {
      const item = await database.repos.items.getById(line.itemId);
      return [line.itemId, item] as const;
    }),
  );
  const itemById = new Map<string, Item>();
  for (const [id, item] of items) {
    if (item) itemById.set(id, item);
  }

  const saleItems = buildSaleItems(input.lines, itemById);
  const tenders: PendingSaleTender[] = [
    {
      method: "qris",
      amountIdr: input.totals.totalIdr,
      reference: input.qrisOrderId,
    },
  ];

  const sale: KassaSale = kassaSale.parse({
    localSaleId: input.localSaleId,
    outletId: deviceSecret.outletId,
    clerkId: deviceSecret.deviceId,
    businessDate,
    createdAt: createdAtIso,
    subtotalIdr: input.totals.subtotalIdr as number,
    discountIdr: input.totals.discountIdr as number,
    totalIdr: input.totals.totalIdr as number,
    items: saleItems,
    tenders,
  });

  const pendingSale: PendingSale = await database.db.transaction(
    "rw",
    database.db.pending_sales,
    database.db.stock_snapshot,
    async () => {
      const row: PendingSale = {
        localSaleId: sale.localSaleId,
        outletId: sale.outletId,
        clerkId: sale.clerkId,
        businessDate: sale.businessDate,
        createdAt: sale.createdAt,
        subtotalIdr: toRupiah(sale.subtotalIdr),
        discountIdr: toRupiah(sale.discountIdr),
        totalIdr: toRupiah(sale.totalIdr),
        items: saleItems.map((line) => ({
          ...line,
          unitPriceIdr: toRupiah(line.unitPriceIdr),
          lineTotalIdr: toRupiah(line.lineTotalIdr),
        })),
        tenders: tenders.map((t) => ({
          ...t,
          amountIdr: toRupiah(t.amountIdr),
        })),
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        serverSaleName: null,
      };
      await database.db.pending_sales.put(row);

      for (const line of input.lines) {
        const item = itemById.get(line.itemId);
        if (!item?.isStockTracked) continue;
        await database.repos.stockSnapshot.applyOptimisticDelta(
          sale.outletId,
          line.itemId,
          -line.quantity,
          createdAtIso,
        );
      }
      return row;
    },
  );

  return {
    localSaleId: sale.localSaleId,
    sale,
    pendingSale,
    changeDueIdr: toRupiah(0),
  };
}

/**
 * Finalise a cart as a static-QRIS-tendered sale (ADR-008 fallback). Called
 * by the static-QRIS tender panel after the clerk confirms the buyer paid
 * to the printed merchant QR. The tender is enqueued to the outbox with
 * `method: "qris_static"`, `verified: false`, and `buyerRefLast4` so the
 * back-office reconciliation job (KASA-64) can match it against the
 * Midtrans EOD settlement report.
 *
 * Static QRIS cannot leave change due, so `changeDueIdr` is always zero.
 */
export async function finalizeQrisStaticSale(
  input: FinalizeQrisStaticInput,
  ctx: FinalizeContext,
): Promise<FinalizeResult> {
  const { database } = ctx;
  const genId = ctx.generateLocalSaleId ?? uuidv7;
  const now = ctx.now?.() ?? new Date();

  if (input.lines.length === 0) {
    throw new SaleFinalizeError("cart is empty");
  }
  if (!/^\d{4}$/.test(input.buyerRefLast4)) {
    throw new SaleFinalizeError("buyerRefLast4 must be exactly 4 digits");
  }

  const deviceSecret = await database.repos.deviceSecret.get();
  if (!deviceSecret) {
    throw new SaleFinalizeError("device is not enrolled");
  }
  const outlet = await database.repos.outlets.getById(deviceSecret.outletId);

  const businessDate = toBusinessDate(now, outlet?.timezone);
  const localSaleId = genId();
  const createdAtIso = now.toISOString();

  const items = await Promise.all(
    input.lines.map(async (line) => {
      const item = await database.repos.items.getById(line.itemId);
      return [line.itemId, item] as const;
    }),
  );
  const itemById = new Map<string, Item>();
  for (const [id, item] of items) {
    if (item) itemById.set(id, item);
  }

  const saleItems = buildSaleItems(input.lines, itemById);
  const tenders: PendingSaleTender[] = [
    {
      method: "qris_static",
      amountIdr: input.totals.totalIdr,
      reference: null,
      verified: false,
      buyerRefLast4: input.buyerRefLast4,
    },
  ];

  const sale: KassaSale = kassaSale.parse({
    localSaleId,
    outletId: deviceSecret.outletId,
    clerkId: deviceSecret.deviceId,
    businessDate,
    createdAt: createdAtIso,
    subtotalIdr: input.totals.subtotalIdr as number,
    discountIdr: input.totals.discountIdr as number,
    totalIdr: input.totals.totalIdr as number,
    items: saleItems,
    tenders,
  });

  // BOM explosion identical to cash/dynamic — the tender method only changes
  // the outbox row, not the inventory accounting.
  const stockMoves = await explodeLines(
    database,
    input.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    itemById,
  );

  const pendingSale: PendingSale = await database.db.transaction(
    "rw",
    database.db.pending_sales,
    database.db.stock_snapshot,
    async () => {
      const row: PendingSale = {
        localSaleId: sale.localSaleId,
        outletId: sale.outletId,
        clerkId: sale.clerkId,
        businessDate: sale.businessDate,
        createdAt: sale.createdAt,
        subtotalIdr: toRupiah(sale.subtotalIdr),
        discountIdr: toRupiah(sale.discountIdr),
        totalIdr: toRupiah(sale.totalIdr),
        items: saleItems.map((line) => ({
          ...line,
          unitPriceIdr: toRupiah(line.unitPriceIdr),
          lineTotalIdr: toRupiah(line.lineTotalIdr),
        })),
        tenders: tenders.map((t) => ({
          ...t,
          amountIdr: toRupiah(t.amountIdr),
        })),
        status: "queued",
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
        serverSaleName: null,
      };
      await database.db.pending_sales.put(row);

      for (const move of stockMoves) {
        await database.repos.stockSnapshot.applyOptimisticDelta(
          sale.outletId,
          move.itemId,
          -move.quantity,
          createdAtIso,
        );
      }
      return row;
    },
  );

  return {
    localSaleId: sale.localSaleId,
    sale,
    pendingSale,
    changeDueIdr: toRupiah(0),
  };
}
