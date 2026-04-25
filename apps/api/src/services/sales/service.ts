import { uuidv7 } from "../../lib/uuid.js";
import type { SalesRepository } from "./repository.js";
import type {
  Item,
  Sale,
  SaleLine,
  SaleTender,
  StockLedgerEntry,
  SubmitSaleInput,
  SubmitSaleResult,
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
      | "idempotency_conflict",
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
