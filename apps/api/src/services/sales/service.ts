import { uuidv7 } from "../../lib/uuid.js";
import type { SalesRepository } from "./repository.js";
import type {
  Item,
  RefundSaleInput,
  RefundSaleResult,
  Sale,
  SaleLine,
  SaleTender,
  StockLedgerEntry,
  SubmitSaleInput,
  SubmitSaleResult,
  VoidSaleInput,
  VoidSaleResult,
} from "./types.js";

/*
 * Sales pipeline. The one rule the server owns that the client cannot: a sale
 * is accepted iff its exploded BOM components pass the per-item
 * `allow_negative` guard. Negative on-hand is allowed for raw materials whose
 * inventory is tracked outside the system (KASA-66 AC).
 *
 * Everything else — BOM version pinning, ledger writes, idempotency — happens
 * here so the route handler stays thin and the same service can be reused by
 * the back-office admin replay tool when that lands.
 */

export class SalesError extends Error {
  constructor(
    readonly code:
      | "outlet_not_found"
      | "outlet_merchant_mismatch"
      | "item_not_found"
      | "item_inactive"
      | "bom_not_found"
      | "insufficient_stock"
      | "idempotency_conflict"
      | "sale_not_found"
      | "sale_voided"
      | "refund_line_not_in_sale"
      | "refund_quantity_exceeds_remaining"
      | "refund_amount_exceeds_remaining"
      | "refund_idempotency_conflict",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SalesError";
  }
}

export interface SubmitSaleOk {
  kind: "ok";
  created: boolean;
  result: SubmitSaleResult;
}

export interface SubmitSaleConflict {
  kind: "conflict";
  existing: Sale;
}

export type SubmitSaleOutcome = SubmitSaleOk | SubmitSaleConflict;

export interface SalesServiceDeps {
  repository: SalesRepository;
  now?: () => Date;
  generateId?: () => string;
  generateSaleName?: (sale: Sale) => string;
}

export class SalesService {
  private readonly repository: SalesRepository;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly generateSaleName: (sale: Sale) => string;

  constructor(deps: SalesServiceDeps) {
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? uuidv7;
    this.generateSaleName = deps.generateSaleName ?? defaultSaleName;
  }

  async submit(input: SubmitSaleInput): Promise<SubmitSaleOutcome> {
    const existing = await this.repository.findSaleByLocalId(input.merchantId, input.localSaleId);
    if (existing) {
      if (!salesAgreeOnShape(existing, input)) {
        throw new SalesError(
          "idempotency_conflict",
          "A sale with this localSaleId already exists with different lines.",
        );
      }
      return { kind: "conflict", existing };
    }

    const outlet = await this.repository.findOutlet(input.merchantId, input.outletId);
    if (!outlet) {
      throw new SalesError(
        "outlet_not_found",
        `Outlet ${input.outletId} is not registered to this merchant.`,
      );
    }

    // Resolve every item referenced by the sale (including BOM components).
    // The set is a union of (line.itemId, each component.componentItemId for
    // line.bomId).
    const saleItems = await this.repository.findItemsByIds(
      input.merchantId,
      input.items.map((line) => line.itemId),
    );
    const saleItemById = new Map(saleItems.map((item) => [item.id, item]));
    for (const line of input.items) {
      const item = saleItemById.get(line.itemId);
      if (!item) {
        throw new SalesError(
          "item_not_found",
          `Item ${line.itemId} is not registered to this merchant.`,
        );
      }
      if (!item.isActive) {
        throw new SalesError("item_inactive", `Item ${item.code} is no longer sold.`);
      }
    }

    // Resolve BOMs once per referenced id. `line.bomId` is a hint — the
    // server authoritatively picks the item's current `bomId`, so if the
    // client is stale the server explodes against the active version.
    const bomIds = new Set<string>();
    for (const line of input.items) {
      const item = saleItemById.get(line.itemId) as Item;
      if (item.bomId) bomIds.add(item.bomId);
    }
    const bomById = new Map(
      await Promise.all(
        [...bomIds].map(async (id) => [id, await this.repository.findBomById(id)] as const),
      ),
    );
    for (const [id, bom] of bomById) {
      if (!bom) {
        throw new SalesError("bom_not_found", `BOM ${id} is not registered.`);
      }
    }

    // 1. Build exploded component list keyed by itemId, summing across lines.
    const componentTotals = new Map<string, number>();
    for (const line of input.items) {
      const item = saleItemById.get(line.itemId) as Item;
      if (item.bomId) {
        const bom = bomById.get(item.bomId);
        if (!bom) {
          throw new SalesError(
            "bom_not_found",
            `BOM ${item.bomId} is not registered for item ${item.code}.`,
          );
        }
        for (const component of bom.components) {
          componentTotals.set(
            component.componentItemId,
            (componentTotals.get(component.componentItemId) ?? 0) +
              component.quantity * line.quantity,
          );
        }
      } else if (item.isStockTracked) {
        componentTotals.set(item.id, (componentTotals.get(item.id) ?? 0) + line.quantity);
      }
    }

    // 2. Load the moved items (components, plus the finished good for
    // non-BOM tracked items) and enforce allow_negative.
    const movedIds = [...componentTotals.keys()];
    const movedItems = await this.repository.findItemsByIds(input.merchantId, movedIds);
    const movedItemById = new Map(movedItems.map((item) => [item.id, item]));
    for (const id of movedIds) {
      if (!movedItemById.has(id)) {
        throw new SalesError(
          "item_not_found",
          `Stock-moved item ${id} is not registered to this merchant.`,
        );
      }
    }

    const onHand = await this.repository.onHandForMany(input.outletId, movedIds);
    for (const [itemId, moved] of componentTotals) {
      const item = movedItemById.get(itemId) as Item;
      if (item.allowNegative) continue;
      const current = onHand.get(itemId) ?? 0;
      if (current - moved < 0) {
        throw new SalesError(
          "insufficient_stock",
          `Insufficient stock for ${item.code} at outlet ${input.outletId}: on_hand=${current}, requested=${moved}.`,
          { itemId, itemCode: item.code, onHand: current, requested: moved },
        );
      }
    }

    // 3. Build the sale row + ledger entries. One entry per moved item,
    // summed across cart lines so a two-cup Kopi Susu order writes a single
    // `-30 beans` row rather than two `-15 beans` rows.
    const saleId = this.generateId();
    const occurredAt = this.now().toISOString();
    const sale: Sale = {
      id: saleId,
      merchantId: input.merchantId,
      outletId: input.outletId,
      clerkId: input.clerkId,
      localSaleId: input.localSaleId,
      name: "",
      businessDate: input.businessDate,
      subtotalIdr: input.subtotalIdr,
      discountIdr: input.discountIdr,
      totalIdr: input.totalIdr,
      items: input.items.map((line) => ({ ...line })),
      tenders: input.tenders.map(normalizeTender),
      createdAt: input.createdAt,
      voidedAt: null,
      voidBusinessDate: null,
      voidReason: null,
      refunds: [],
    };
    sale.name = this.generateSaleName(sale);

    const ledgerInputs: Omit<StockLedgerEntry, "id">[] = [];
    for (const [itemId, moved] of componentTotals) {
      ledgerInputs.push({
        outletId: input.outletId,
        itemId,
        delta: -moved,
        reason: "sale",
        refType: "sale",
        refId: saleId,
        occurredAt,
      });
    }

    const persisted = await this.repository.recordSale({
      sale,
      ledger: ledgerInputs,
      idGenerator: this.generateId,
    });
    return {
      kind: "ok",
      created: true,
      result: { sale: persisted.sale, ledger: persisted.ledger },
    };
  }

  /**
   * Cancel an entire sale. Writes balancing positive ledger rows mirroring
   * the original sale's negative deltas (`reason="sale_void"`). Idempotent on
   * `saleId` — replaying after a successful void returns the originally
   * stamped `voidedAt` with empty ledger.
   */
  async void(input: VoidSaleInput): Promise<{ created: boolean; result: VoidSaleResult }> {
    const sale = await this.repository.findSaleById(input.merchantId, input.saleId);
    if (!sale) {
      throw new SalesError("sale_not_found", `Sale ${input.saleId} not found.`);
    }
    if (sale.voidedAt) {
      // Idempotent — surface the original void without rewriting ledger.
      return { created: false, result: { sale, ledger: [] } };
    }
    if (sale.refunds.length > 0) {
      throw new SalesError("sale_voided", "Cannot void a sale that already has booked refunds.", {
        saleId: sale.id,
        refundCount: sale.refunds.length,
      });
    }

    // Mirror the original sale's stock movements with positive deltas. We
    // rebuild the moved-item list from `sale.items` × server-resolved BOMs so
    // the void is internally consistent even if the client's view of the BOM
    // version drifted between submit and void.
    const componentTotals = await this.explodeSaleComponents(sale);

    const ledgerInputs: Omit<StockLedgerEntry, "id">[] = [];
    for (const [itemId, moved] of componentTotals) {
      ledgerInputs.push({
        outletId: sale.outletId,
        itemId,
        delta: moved,
        reason: "sale_void",
        refType: "sale",
        refId: sale.id,
        occurredAt: input.voidedAt,
      });
    }

    const persisted = await this.repository.voidSale({
      merchantId: input.merchantId,
      saleId: input.saleId,
      voidedAt: input.voidedAt,
      voidBusinessDate: input.voidBusinessDate,
      reason: input.reason,
      ledger: ledgerInputs,
      idGenerator: this.generateId,
    });
    if (persisted.kind === "already_voided") {
      return { created: false, result: { sale: persisted.sale, ledger: [] } };
    }
    return { created: true, result: { sale: persisted.sale, ledger: persisted.ledger } };
  }

  /**
   * Book a (full or partial) refund. Writes positive ledger rows for each
   * refunded line (`reason="refund"`). Idempotent on `clientRefundId` — a
   * replay returns the originally booked refund row with empty ledger.
   */
  async refund(input: RefundSaleInput): Promise<{ created: boolean; result: RefundSaleResult }> {
    const sale = await this.repository.findSaleById(input.merchantId, input.saleId);
    if (!sale) {
      throw new SalesError("sale_not_found", `Sale ${input.saleId} not found.`);
    }
    if (sale.voidedAt) {
      throw new SalesError("sale_voided", "Cannot refund a voided sale.", {
        saleId: sale.id,
        voidedAt: sale.voidedAt,
      });
    }

    // Idempotency — replay returns the originally booked refund.
    const replay = sale.refunds.find((row) => row.clientRefundId === input.clientRefundId);
    if (replay) {
      // Detect a client-side state drift: same clientRefundId, different shape.
      // Surface as 409 so the operator notices, rather than silently 200ing.
      if (replay.amountIdr !== input.amountIdr || !linesAgree(replay.lines, input.lines)) {
        throw new SalesError(
          "refund_idempotency_conflict",
          "A refund with this clientRefundId already exists with different lines or amount.",
          { saleId: sale.id, clientRefundId: input.clientRefundId },
        );
      }
      return { created: false, result: { sale, refund: replay, ledger: [] } };
    }

    // Validate refund line shape against original sale lines and remaining
    // refundable quantities.
    const remainingByItem = remainingRefundableByItem(sale);
    for (const line of input.lines) {
      const remaining = remainingByItem.get(line.itemId);
      if (remaining === undefined) {
        throw new SalesError(
          "refund_line_not_in_sale",
          `Refund line ${line.itemId} is not part of sale ${sale.id}.`,
          { saleId: sale.id, itemId: line.itemId },
        );
      }
      if (line.quantity > remaining) {
        throw new SalesError(
          "refund_quantity_exceeds_remaining",
          `Refund quantity for ${line.itemId} exceeds remaining (${remaining}).`,
          { saleId: sale.id, itemId: line.itemId, requested: line.quantity, remaining },
        );
      }
    }

    const refundedAmountToDate = sale.refunds.reduce((sum, r) => sum + r.amountIdr, 0);
    if (refundedAmountToDate + input.amountIdr > sale.totalIdr) {
      throw new SalesError(
        "refund_amount_exceeds_remaining",
        "Refund amount exceeds the remaining refundable total.",
        {
          saleId: sale.id,
          requested: input.amountIdr,
          remaining: sale.totalIdr - refundedAmountToDate,
        },
      );
    }

    // Build balancing ledger rows: one per refunded line, exploded against
    // BOMs the same way the sale was. This yields per-component positive
    // deltas that mirror the original sale's negative entries.
    const componentTotals = await this.explodeRefundLines(sale, input.lines);

    const ledgerInputs: Omit<StockLedgerEntry, "id">[] = [];
    for (const [itemId, moved] of componentTotals) {
      ledgerInputs.push({
        outletId: sale.outletId,
        itemId,
        delta: moved,
        reason: "refund",
        refType: "sale",
        refId: sale.id,
        occurredAt: input.refundedAt,
      });
    }

    const persisted = await this.repository.recordRefund({
      merchantId: input.merchantId,
      saleId: input.saleId,
      clientRefundId: input.clientRefundId,
      refundedAt: input.refundedAt,
      refundBusinessDate: input.refundBusinessDate,
      amountIdr: input.amountIdr,
      reason: input.reason,
      lines: input.lines,
      ledger: ledgerInputs,
      idGenerator: this.generateId,
    });
    if (persisted.kind === "already_refunded") {
      return {
        created: false,
        result: { sale: persisted.sale, refund: persisted.refund, ledger: [] },
      };
    }
    return {
      created: true,
      result: { sale: persisted.sale, refund: persisted.refund, ledger: persisted.ledger },
    };
  }

  /**
   * Resolve per-itemId moved totals for an entire sale (used by void). Mirrors
   * the explosion done at submit time: BOM lines fan out into components,
   * non-BOM stock-tracked lines move themselves, untracked finished goods do
   * not move.
   */
  private async explodeSaleComponents(sale: Sale): Promise<Map<string, number>> {
    return this.explodeLines(
      sale.merchantId,
      sale.items.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    );
  }

  private async explodeRefundLines(
    sale: Sale,
    lines: readonly { itemId: string; quantity: number }[],
  ): Promise<Map<string, number>> {
    return this.explodeLines(sale.merchantId, lines);
  }

  private async explodeLines(
    merchantId: string,
    lines: readonly { itemId: string; quantity: number }[],
  ): Promise<Map<string, number>> {
    const items = await this.repository.findItemsByIds(
      merchantId,
      lines.map((line) => line.itemId),
    );
    const itemById = new Map(items.map((row) => [row.id, row]));

    const bomIds = new Set<string>();
    for (const line of lines) {
      const item = itemById.get(line.itemId);
      if (item?.bomId) bomIds.add(item.bomId);
    }
    const bomById = new Map(
      await Promise.all(
        [...bomIds].map(async (id) => [id, await this.repository.findBomById(id)] as const),
      ),
    );

    const totals = new Map<string, number>();
    for (const line of lines) {
      const item = itemById.get(line.itemId);
      if (!item) continue;
      if (item.bomId) {
        const bom = bomById.get(item.bomId);
        if (!bom) continue;
        for (const component of bom.components) {
          totals.set(
            component.componentItemId,
            (totals.get(component.componentItemId) ?? 0) + component.quantity * line.quantity,
          );
        }
      } else if (item.isStockTracked) {
        totals.set(item.id, (totals.get(item.id) ?? 0) + line.quantity);
      }
    }
    return totals;
  }
}

function defaultSaleName(sale: Sale): string {
  return `SALE-${sale.businessDate.replaceAll("-", "")}-${sale.id.slice(0, 8)}`;
}

function normalizeTender(tender: SaleTender): SaleTender {
  if (tender.method === "qris_static") {
    // Always store qris_static as unverified at write time; reconciliation
    // (KASA-64) flips the persisted row when the Midtrans settlement
    // matches. The wire schema already rejects `verified === true` here,
    // so this is belt-and-braces against any future caller paths.
    return {
      method: tender.method,
      amountIdr: tender.amountIdr,
      reference: tender.reference,
      verified: false,
      buyerRefLast4: tender.buyerRefLast4 ?? null,
    };
  }
  return { ...tender };
}

function salesAgreeOnShape(existing: Sale, input: SubmitSaleInput): boolean {
  if (existing.outletId !== input.outletId) return false;
  if (existing.totalIdr !== input.totalIdr) return false;
  if (existing.items.length !== input.items.length) return false;
  for (let i = 0; i < existing.items.length; i += 1) {
    const a = existing.items[i] as SaleLine;
    const b = input.items[i] as SaleLine;
    if (a.itemId !== b.itemId) return false;
    if (a.quantity !== b.quantity) return false;
    if (a.lineTotalIdr !== b.lineTotalIdr) return false;
  }
  return true;
}

function linesAgree(
  a: readonly { itemId: string; quantity: number }[],
  b: readonly { itemId: string; quantity: number }[],
): boolean {
  if (a.length !== b.length) return false;
  const sortKey = (line: { itemId: string; quantity: number }) => `${line.itemId}|${line.quantity}`;
  const sortedA = [...a].map(sortKey).sort();
  const sortedB = [...b].map(sortKey).sort();
  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/**
 * Per-itemId remaining refundable quantity = original sale-line quantity
 * minus the sum of already-refunded quantity for that itemId. The map only
 * contains itemIds that appeared in `sale.items`.
 */
function remainingRefundableByItem(sale: Sale): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const line of sale.items) {
    remaining.set(line.itemId, (remaining.get(line.itemId) ?? 0) + line.quantity);
  }
  for (const refund of sale.refunds) {
    for (const line of refund.lines) {
      const current = remaining.get(line.itemId);
      if (current !== undefined) {
        remaining.set(line.itemId, current - line.quantity);
      }
    }
  }
  return remaining;
}
