import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { PgItemsRepository } from "../src/services/catalog/pg-repository.js";
import { ItemCodeConflictError, ItemForeignKeyError } from "../src/services/catalog/service.js";

/**
 * KASA-114: the Pg repo translates `foreign_key_violation` (`23503`) on the
 * `items.uom_id` / `items.bom_id` constraints into `ItemForeignKeyError` so
 * the service can map it to a 404. These tests build a stub `db` whose
 * `insert` / `update` chain throws a synthetic `pg` error matching the
 * structure `node-postgres` surfaces (`code` + `constraint` properties).
 */

const MERCHANT = "01890abc-1234-7def-8000-00000000aaa1";
const ITEM_ID = "01890abc-1234-7def-8000-00000000c0a1";
const UOM_ID = "01890abc-1234-7def-8000-0000000c0001";
const BOM_ID = "01890abc-1234-7def-8000-0000000b0001";
const NOW = new Date("2026-04-26T00:00:00Z");

interface PgError extends Error {
  code: string;
  constraint?: string;
}

function pgError(code: string, constraint?: string): PgError {
  const err = new Error(`synthetic ${code}${constraint ? ` on ${constraint}` : ""}`) as PgError;
  err.code = code;
  if (constraint) err.constraint = constraint;
  return err;
}

function insertThrowing(err: unknown): Database {
  return {
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(err),
      }),
    }),
  } as unknown as Database;
}

function updateThrowing(err: unknown): Database {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.reject(err),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("PgItemsRepository.createItem error translation", () => {
  it("maps 23503 on items_uom_id_uoms_id_fk to ItemForeignKeyError(uom_not_found)", async () => {
    const repo = new PgItemsRepository(insertThrowing(pgError("23503", "items_uom_id_uoms_id_fk")));
    await expect(
      repo.createItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        code: "SKU-1",
        name: "Coffee",
        priceIdr: 25_000,
        uomId: UOM_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      name: "ItemForeignKeyError",
      target: "uom_not_found",
      id: UOM_ID,
    });
  });

  it("maps 23503 on items_bom_id_boms_id_fk to ItemForeignKeyError(bom_not_found)", async () => {
    const repo = new PgItemsRepository(insertThrowing(pgError("23503", "items_bom_id_boms_id_fk")));
    await expect(
      repo.createItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        code: "SKU-1",
        name: "Coffee",
        priceIdr: 25_000,
        uomId: UOM_ID,
        bomId: BOM_ID,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ItemForeignKeyError);
  });

  it("still maps 23505 to ItemCodeConflictError", async () => {
    const repo = new PgItemsRepository(insertThrowing(pgError("23505")));
    await expect(
      repo.createItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        code: "SKU-1",
        name: "Coffee",
        priceIdr: 25_000,
        uomId: UOM_ID,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ItemCodeConflictError);
  });

  it("rethrows 23503 from an unrelated constraint untouched", async () => {
    const synthetic = pgError("23503", "some_other_fk");
    const repo = new PgItemsRepository(insertThrowing(synthetic));
    await expect(
      repo.createItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        code: "SKU-1",
        name: "Coffee",
        priceIdr: 25_000,
        uomId: UOM_ID,
        now: NOW,
      }),
    ).rejects.toBe(synthetic);
  });

  it("rethrows non-pg errors untouched", async () => {
    const synthetic = new Error("boom");
    const repo = new PgItemsRepository(insertThrowing(synthetic));
    await expect(
      repo.createItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        code: "SKU-1",
        name: "Coffee",
        priceIdr: 25_000,
        uomId: UOM_ID,
        now: NOW,
      }),
    ).rejects.toBe(synthetic);
  });
});

describe("PgItemsRepository.updateItem error translation", () => {
  it("maps 23503 on items_uom_id_uoms_id_fk to ItemForeignKeyError(uom_not_found)", async () => {
    const repo = new PgItemsRepository(updateThrowing(pgError("23503", "items_uom_id_uoms_id_fk")));
    await expect(
      repo.updateItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        patch: { uomId: UOM_ID },
        now: NOW,
      }),
    ).rejects.toMatchObject({
      name: "ItemForeignKeyError",
      target: "uom_not_found",
      id: UOM_ID,
    });
  });

  it("maps 23503 on items_bom_id_boms_id_fk to ItemForeignKeyError(bom_not_found)", async () => {
    const repo = new PgItemsRepository(updateThrowing(pgError("23503", "items_bom_id_boms_id_fk")));
    await expect(
      repo.updateItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        patch: { bomId: BOM_ID },
        now: NOW,
      }),
    ).rejects.toMatchObject({
      name: "ItemForeignKeyError",
      target: "bom_not_found",
      id: BOM_ID,
    });
  });

  it("still maps 23505 with a code patch to ItemCodeConflictError", async () => {
    const repo = new PgItemsRepository(updateThrowing(pgError("23505")));
    await expect(
      repo.updateItem({
        id: ITEM_ID,
        merchantId: MERCHANT,
        patch: { code: "SKU-2" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ItemCodeConflictError);
  });
});
