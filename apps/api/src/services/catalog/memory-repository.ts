import type { Item } from "../../db/schema/items.js";
import { ItemCodeConflictError } from "./service.js";
import {
  type BulkUpsertItemsInput,
  type BulkUpsertItemsResult,
  type BulkUpsertItemsRowResult,
  BulkUpsertItemsRowError,
  type CreateItemInput,
  type ItemsRepository,
  type ListItemsInput,
  type ListItemsResult,
  type UpdateItemInput,
} from "./repository.js";

/**
 * In-memory repo for tests. Enforces the same invariants as the Pg impl:
 * unique `(merchantId, code)` and merchant-scoped reads. Ordering for `list`
 * is `(updatedAt ASC, id ASC)` — matches the Pg index and keeps the cursor
 * semantics identical.
 */
export class InMemoryItemsRepository implements ItemsRepository {
  private readonly items = new Map<string, Item>();
  private readonly uoms = new Set<string>();
  private readonly boms = new Set<string>();
  private readonly merchantScopedUoms = new Map<string, Set<string>>();
  private readonly merchantScopedBoms = new Map<string, Set<string>>();

  seedUom(merchantId: string, uomId: string): void {
    this.uoms.add(uomId);
    const set = this.merchantScopedUoms.get(merchantId) ?? new Set<string>();
    set.add(uomId);
    this.merchantScopedUoms.set(merchantId, set);
  }

  seedBom(merchantId: string, bomId: string): void {
    this.boms.add(bomId);
    const set = this.merchantScopedBoms.get(merchantId) ?? new Set<string>();
    set.add(bomId);
    this.merchantScopedBoms.set(merchantId, set);
  }

  async findUom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const set = this.merchantScopedUoms.get(input.merchantId);
    return set?.has(input.id) ? { id: input.id } : null;
  }

  async findBom(input: { id: string; merchantId: string }): Promise<{ id: string } | null> {
    const set = this.merchantScopedBoms.get(input.merchantId);
    return set?.has(input.id) ? { id: input.id } : null;
  }

  async findItem(input: { id: string; merchantId: string }): Promise<Item | null> {
    const row = this.items.get(input.id);
    if (!row || row.merchantId !== input.merchantId) return null;
    return { ...row };
  }

  async listItems(input: ListItemsInput): Promise<ListItemsResult> {
    const cursorBoundary = input.cursor
      ? { updatedAt: new Date(input.cursor.updatedAt), id: input.cursor.id }
      : null;
    const updatedAfter = input.updatedAfter;

    const filtered = [...this.items.values()]
      .filter((row) => row.merchantId === input.merchantId)
      .filter((row) => {
        if (cursorBoundary) {
          if (row.updatedAt.getTime() > cursorBoundary.updatedAt.getTime()) return true;
          if (row.updatedAt.getTime() === cursorBoundary.updatedAt.getTime()) {
            return row.id > cursorBoundary.id;
          }
          return false;
        }
        if (updatedAfter) return row.updatedAt.getTime() > updatedAfter.getTime();
        return true;
      })
      .sort((a, b) => {
        const diff = a.updatedAt.getTime() - b.updatedAt.getTime();
        if (diff !== 0) return diff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

    const page = filtered.slice(0, input.limit);
    const hasMore = filtered.length > input.limit;
    const last = page.at(-1) ?? null;
    const nextBoundary = last ? { updatedAtIso: last.updatedAt.toISOString(), id: last.id } : null;

    return { records: page.map((r) => ({ ...r })), nextBoundary, hasMore };
  }

  async createItem(input: CreateItemInput): Promise<Item> {
    for (const existing of this.items.values()) {
      if (existing.merchantId === input.merchantId && existing.code === input.code) {
        throw new ItemCodeConflictError(input.code);
      }
    }
    const row: Item = {
      id: input.id,
      merchantId: input.merchantId,
      code: input.code,
      name: input.name,
      priceIdr: input.priceIdr,
      uomId: input.uomId,
      bomId: input.bomId ?? null,
      isStockTracked: input.isStockTracked ?? true,
      allowNegative: false,
      taxRate: input.taxRate ?? 11,
      availability: input.availability ?? "available",
      isActive: input.isActive ?? true,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.items.set(row.id, row);
    return { ...row };
  }

  async updateItem(input: UpdateItemInput): Promise<Item | null> {
    const current = this.items.get(input.id);
    if (!current || current.merchantId !== input.merchantId) return null;
    if (input.patch.code !== undefined && input.patch.code !== current.code) {
      for (const existing of this.items.values()) {
        if (
          existing.id !== current.id &&
          existing.merchantId === current.merchantId &&
          existing.code === input.patch.code
        ) {
          throw new ItemCodeConflictError(input.patch.code);
        }
      }
    }
    const next: Item = {
      ...current,
      ...(input.patch.code !== undefined ? { code: input.patch.code } : {}),
      ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
      ...(input.patch.priceIdr !== undefined ? { priceIdr: input.patch.priceIdr } : {}),
      ...(input.patch.uomId !== undefined ? { uomId: input.patch.uomId } : {}),
      ...(input.patch.bomId !== undefined ? { bomId: input.patch.bomId } : {}),
      ...(input.patch.isStockTracked !== undefined
        ? { isStockTracked: input.patch.isStockTracked }
        : {}),
      ...(input.patch.taxRate !== undefined ? { taxRate: input.patch.taxRate } : {}),
      ...(input.patch.availability !== undefined ? { availability: input.patch.availability } : {}),
      ...(input.patch.isActive !== undefined ? { isActive: input.patch.isActive } : {}),
      updatedAt: input.now,
    };
    this.items.set(next.id, next);
    return { ...next };
  }

  async softDeleteItem(input: { id: string; merchantId: string; now: Date }): Promise<Item | null> {
    const current = this.items.get(input.id);
    if (!current || current.merchantId !== input.merchantId) return null;
    const next: Item = { ...current, isActive: false, updatedAt: input.now };
    this.items.set(next.id, next);
    return { ...next };
  }

  async bulkUpsertItems(input: BulkUpsertItemsInput): Promise<BulkUpsertItemsResult> {
    // Snapshot the slice the batch can mutate so we can restore on error and
    // mirror the Pg-side transaction rollback. We snapshot per id rather than
    // copying the whole map to keep the cost proportional to the batch size.
    const snapshot = new Map<string, Item | undefined>();
    const byCodeIndex = new Map<string, Item>();
    for (const row of this.items.values()) {
      if (row.merchantId === input.merchantId) {
        byCodeIndex.set(row.code, row);
      }
    }

    const rows: BulkUpsertItemsRowResult[] = [];
    try {
      for (let idx = 0; idx < input.rows.length; idx++) {
        const row = input.rows[idx]!;
        const merchantUomSet = this.merchantScopedUoms.get(input.merchantId);
        if (!merchantUomSet?.has(row.uomId)) {
          throw new BulkUpsertItemsRowError(idx, "uom_not_found", row.uomId);
        }
        if (row.bomId) {
          const merchantBomSet = this.merchantScopedBoms.get(input.merchantId);
          if (!merchantBomSet?.has(row.bomId)) {
            throw new BulkUpsertItemsRowError(idx, "bom_not_found", row.bomId);
          }
        }

        const existing = byCodeIndex.get(row.code);
        if (!existing) {
          const id = input.generateId();
          if (!snapshot.has(id)) snapshot.set(id, undefined);
          const inserted: Item = {
            id,
            merchantId: input.merchantId,
            code: row.code,
            name: row.name,
            priceIdr: row.priceIdr,
            uomId: row.uomId,
            bomId: row.bomId ?? null,
            isStockTracked: row.isStockTracked ?? true,
            taxRate: 11,
            availability: "available",
            allowNegative: false,
            isActive: row.isActive ?? true,
            createdAt: input.now,
            updatedAt: input.now,
          };
          this.items.set(id, inserted);
          byCodeIndex.set(row.code, inserted);
          rows.push({ index: idx, code: row.code, status: "created", item: { ...inserted } });
          continue;
        }

        const desired: Item = {
          ...existing,
          name: row.name,
          priceIdr: row.priceIdr,
          uomId: row.uomId,
          bomId: row.bomId ?? null,
          isStockTracked: row.isStockTracked ?? existing.isStockTracked,
          isActive: row.isActive ?? existing.isActive,
        };

        if (
          desired.name === existing.name &&
          desired.priceIdr === existing.priceIdr &&
          desired.uomId === existing.uomId &&
          desired.bomId === existing.bomId &&
          desired.isStockTracked === existing.isStockTracked &&
          desired.isActive === existing.isActive
        ) {
          rows.push({ index: idx, code: row.code, status: "unchanged", item: { ...existing } });
          continue;
        }

        if (!snapshot.has(existing.id)) snapshot.set(existing.id, { ...existing });
        const updated: Item = { ...desired, updatedAt: input.now };
        this.items.set(existing.id, updated);
        byCodeIndex.set(row.code, updated);
        rows.push({ index: idx, code: row.code, status: "updated", item: { ...updated } });
      }
      return { rows };
    } catch (err) {
      for (const [id, original] of snapshot) {
        if (original === undefined) this.items.delete(id);
        else this.items.set(id, original);
      }
      throw err;
    }
  }
}
