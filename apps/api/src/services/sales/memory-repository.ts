import type { LedgerAppendInput, SalesRepository } from "./repository.js";
import type { Bom, Item, Outlet, Sale, StockLedgerEntry } from "./types.js";

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
    this.sales.set(input.sale.id, input.sale);
    this.saleIdByLocal.set(key, input.sale.id);
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
    return { sale: input.sale, ledger: written };
  }
}
