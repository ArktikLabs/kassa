import type { LedgerAppendInput, SalesRepository } from "./repository.js";
import type { Bom, Item, Outlet, Sale, SaleRefund, StockLedgerEntry } from "./types.js";

export class InMemorySalesRepository implements SalesRepository {
  private readonly items = new Map<string, Item>();
  private readonly boms = new Map<string, Bom>();
  private readonly outlets = new Map<string, Outlet>();
  private readonly sales = new Map<string, Sale>();
  /** (merchantId::localSaleId) → saleId — enforces client idempotency. */
  private readonly saleIdByLocal = new Map<string, string>();
  private readonly ledger: StockLedgerEntry[] = [];

  // Seed helpers (tests + bootstrap). Not part of SalesRepository — route
  // handlers never call these.
  seedItems(items: readonly Item[]): void {
    for (const item of items) this.items.set(item.id, item);
  }
  seedBoms(boms: readonly Bom[]): void {
    for (const bom of boms) this.boms.set(bom.id, bom);
  }
  seedOutlets(outlets: readonly Outlet[]): void {
    for (const outlet of outlets) this.outlets.set(outlet.id, outlet);
  }
  seedLedger(entries: readonly LedgerAppendInput[], idGenerator: () => string): void {
    for (const entry of entries) {
      this.ledger.push({
        id: idGenerator(),
        outletId: entry.outletId,
        itemId: entry.itemId,
        delta: entry.delta,
        reason: entry.reason,
        refType: entry.refType,
        refId: entry.refId,
        occurredAt: entry.occurredAt,
      });
    }
  }

  // Test-only snapshot accessors.
  _peekLedger(): readonly StockLedgerEntry[] {
    return this.ledger;
  }
  _peekSales(): readonly Sale[] {
    return [...this.sales.values()];
  }

  async findItemsByIds(merchantId: string, itemIds: readonly string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of itemIds) {
      const item = this.items.get(id);
      if (item && item.merchantId === merchantId) out.push(item);
    }
    return out;
  }

  async findBomById(bomId: string): Promise<Bom | null> {
    return this.boms.get(bomId) ?? null;
  }

  async findOutlet(merchantId: string, outletId: string): Promise<Outlet | null> {
    const row = this.outlets.get(outletId);
    if (!row || row.merchantId !== merchantId) return null;
    return row;
  }

  async findSaleByLocalId(merchantId: string, localSaleId: string): Promise<Sale | null> {
    const saleId = this.saleIdByLocal.get(`${merchantId}::${localSaleId}`);
    if (!saleId) return null;
    return this.sales.get(saleId) ?? null;
  }

  async onHandFor(outletId: string, itemId: string): Promise<number> {
    let total = 0;
    for (const row of this.ledger) {
      if (row.outletId === outletId && row.itemId === itemId) total += row.delta;
    }
    return total;
  }

  async onHandForMany(outletId: string, itemIds: readonly string[]): Promise<Map<string, number>> {
    const ids = new Set(itemIds);
    const out = new Map<string, number>();
    for (const id of ids) out.set(id, 0);
    for (const row of this.ledger) {
      if (row.outletId !== outletId) continue;
      if (!ids.has(row.itemId)) continue;
      out.set(row.itemId, (out.get(row.itemId) ?? 0) + row.delta);
    }
    return out;
  }

  async allOnHandForOutlet(outletId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const row of this.ledger) {
      if (row.outletId !== outletId) continue;
      out.set(row.itemId, (out.get(row.itemId) ?? 0) + row.delta);
    }
    return out;
  }

  async listSalesByBusinessDate(
    merchantId: string,
    outletId: string,
    businessDate: string,
  ): Promise<readonly Sale[]> {
    const matches: Sale[] = [];
    for (const sale of this.sales.values()) {
      if (
        sale.merchantId === merchantId &&
        sale.outletId === outletId &&
        sale.businessDate === businessDate
      ) {
        matches.push(sale);
      }
    }
    return matches.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async recordSale(input: {
    sale: Sale;
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<{ sale: Sale; ledger: StockLedgerEntry[] }> {
    const key = `${input.sale.merchantId}::${input.sale.localSaleId}`;
    if (this.saleIdByLocal.has(key)) {
      // Should not happen: the service checks idempotency before calling. If
      // two concurrent submits race here, whichever lost plays back as the
      // existing sale — consistent with (merchantId, localSaleId) being unique.
      // TODO(KASA-21): the Postgres impl must translate the (merchant_id,
      // local_sale_id) unique-violation into a SubmitSaleConflict so the
      // route returns 409, not 201. Returning empty ledger as 201 here is
      // unreachable on the single-threaded JS loop but would be wrong on
      // a real DB.
      const existing = this.sales.get(this.saleIdByLocal.get(key) as string);
      if (existing) {
        return { sale: existing, ledger: [] };
      }
    }
    const stored: Sale = {
      ...input.sale,
      voidedAt: input.sale.voidedAt ?? null,
      voidBusinessDate: input.sale.voidBusinessDate ?? null,
      voidReason: input.sale.voidReason ?? null,
      refunds: input.sale.refunds ?? [],
    };
    this.sales.set(stored.id, stored);
    this.saleIdByLocal.set(key, stored.id);
    const written: StockLedgerEntry[] = input.ledger.map((entry) => ({
      id: input.idGenerator(),
      outletId: entry.outletId,
      itemId: entry.itemId,
      delta: entry.delta,
      reason: entry.reason,
      refType: entry.refType,
      refId: entry.refId,
      occurredAt: entry.occurredAt,
    }));
    for (const row of written) this.ledger.push(row);
    return { sale: stored, ledger: written };
  }

  async findSaleById(merchantId: string, saleId: string): Promise<Sale | null> {
    const sale = this.sales.get(saleId);
    if (!sale || sale.merchantId !== merchantId) return null;
    return sale;
  }

  async voidSale(input: {
    merchantId: string;
    saleId: string;
    voidedAt: string;
    voidBusinessDate: string;
    reason: string | null;
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<
    { kind: "ok"; sale: Sale; ledger: StockLedgerEntry[] } | { kind: "already_voided"; sale: Sale }
  > {
    const sale = this.sales.get(input.saleId);
    if (!sale || sale.merchantId !== input.merchantId) {
      // Service guards before this; defensive — should not happen.
      throw new Error(`voidSale: sale ${input.saleId} not visible to merchant.`);
    }
    if (sale.voidedAt) {
      return { kind: "already_voided", sale };
    }
    const updated: Sale = {
      ...sale,
      voidedAt: input.voidedAt,
      voidBusinessDate: input.voidBusinessDate,
      voidReason: input.reason,
    };
    this.sales.set(sale.id, updated);
    const written: StockLedgerEntry[] = input.ledger.map((entry) => ({
      id: input.idGenerator(),
      outletId: entry.outletId,
      itemId: entry.itemId,
      delta: entry.delta,
      reason: entry.reason,
      refType: entry.refType,
      refId: entry.refId,
      occurredAt: entry.occurredAt,
    }));
    for (const row of written) this.ledger.push(row);
    return { kind: "ok", sale: updated, ledger: written };
  }

  async recordRefund(input: {
    merchantId: string;
    saleId: string;
    clientRefundId: string;
    refundedAt: string;
    refundBusinessDate: string;
    amountIdr: number;
    reason: string | null;
    lines: readonly { itemId: string; quantity: number }[];
    ledger: readonly Omit<StockLedgerEntry, "id">[];
    idGenerator: () => string;
  }): Promise<
    | { kind: "ok"; sale: Sale; refund: SaleRefund; ledger: StockLedgerEntry[] }
    | { kind: "already_refunded"; sale: Sale; refund: SaleRefund }
  > {
    const sale = this.sales.get(input.saleId);
    if (!sale || sale.merchantId !== input.merchantId) {
      throw new Error(`recordRefund: sale ${input.saleId} not visible to merchant.`);
    }
    const existing = sale.refunds.find((row) => row.clientRefundId === input.clientRefundId);
    if (existing) {
      return { kind: "already_refunded", sale, refund: existing };
    }
    const refund: SaleRefund = {
      id: input.idGenerator(),
      clientRefundId: input.clientRefundId,
      refundedAt: input.refundedAt,
      refundBusinessDate: input.refundBusinessDate,
      amountIdr: input.amountIdr,
      reason: input.reason,
      lines: input.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    };
    const updated: Sale = {
      ...sale,
      refunds: [...sale.refunds, refund],
    };
    this.sales.set(sale.id, updated);
    const written: StockLedgerEntry[] = input.ledger.map((entry) => ({
      id: input.idGenerator(),
      outletId: entry.outletId,
      itemId: entry.itemId,
      delta: entry.delta,
      reason: entry.reason,
      refType: entry.refType,
      refId: entry.refId,
      occurredAt: entry.occurredAt,
    }));
    for (const row of written) this.ledger.push(row);
    return { kind: "ok", sale: updated, refund, ledger: written };
  }
}
