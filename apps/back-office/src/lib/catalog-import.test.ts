import { describe, expect, it } from "vitest";
import { CSV_HEADER, buildCsvTemplate, diffAgainstCatalog, parseCsv } from "./catalog-import";
import type { CatalogItem } from "../data/types";

describe("catalog-import: parseCsv", () => {
  it("parses a happy-path CSV and exposes typed drafts", () => {
    const csv = [
      CSV_HEADER.join(","),
      "NSI-001,Nasi Ayam,25000,porsi,false,true",
      "KOP-001,Kopi Susu,18000,pcs,false,true",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.fileErrors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.draft).toEqual({
      sku: "NSI-001",
      name: "Nasi Ayam",
      priceIdr: 25000,
      uom: "porsi",
      imageUrl: null,
      isStockTracked: false,
      availability: "available",
      isActive: true,
    });
    expect(result.rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  it("strips the UTF-8 BOM that Excel emits", () => {
    const csv = `﻿${CSV_HEADER.join(",")}\nNSI-001,Nasi Ayam,25000,porsi,false,true\n`;
    const result = parseCsv(csv);
    expect(result.fileErrors).toEqual([]);
    expect(result.rows[0]!.draft?.sku).toBe("NSI-001");
  });

  it("normalises CRLF line endings", () => {
    const csv = `${CSV_HEADER.join(",")}\r\nNSI-001,Nasi Ayam,25000,porsi,false,true\r\n`;
    const result = parseCsv(csv);
    expect(result.fileErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.draft?.sku).toBe("NSI-001");
  });

  it("flags rows with missing required fields", () => {
    const csv = [
      CSV_HEADER.join(","),
      ",,25000,porsi,false,true",
      "OK-001,Valid,8000,pcs,false,true",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[0]!.draft).toBeNull();
    expect(result.rows[0]!.errors).toContain("sku is required");
    expect(result.rows[0]!.errors).toContain("name is required");
    expect(result.rows[1]!.draft).not.toBeNull();
  });

  it("flags non-integer / negative prices", () => {
    const csv = [
      CSV_HEADER.join(","),
      "X-1,Bad price,-5,pcs,false,true",
      "X-2,Bad price,1.5,pcs,false,true",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[0]!.errors).toContain("price_idr must be a non-negative integer");
    expect(result.rows[1]!.errors).toContain("price_idr must be a non-negative integer");
  });

  it("flags unknown uom values", () => {
    const csv = [CSV_HEADER.join(","), "X-1,Bad uom,1000,carton,false,true"].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[0]!.errors.some((e) => e.startsWith("uom must be one of"))).toBe(true);
  });

  it("flags duplicate SKUs within the file", () => {
    const csv = [
      CSV_HEADER.join(","),
      "DUP-1,A,1000,pcs,false,true",
      "DUP-1,B,2000,pcs,false,true",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[1]!.errors.some((e) => e.includes("duplicate sku"))).toBe(true);
  });

  it("reports file-level error for missing required columns", () => {
    const csv = "sku,name\nNSI-001,Nasi Ayam";
    const result = parseCsv(csv);
    expect(result.fileErrors.length).toBeGreaterThan(0);
    expect(result.fileErrors[0]!).toContain("Missing required column");
  });

  it("handles quoted fields with commas", () => {
    const csv = [
      CSV_HEADER.join(","),
      `"NSI-001","Nasi Ayam, spesial",25000,porsi,false,true`,
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[0]!.draft?.name).toBe("Nasi Ayam, spesial");
  });
});

describe("catalog-import: diffAgainstCatalog", () => {
  const existing: CatalogItem[] = [
    {
      id: "id-1",
      sku: "EXIST-1",
      name: "Existing One",
      priceIdr: 10000,
      uom: "pcs",
      imageUrl: null,
      isStockTracked: false,
      availability: "available",
      isActive: true,
    },
  ];

  it("splits rows into create / update / unchanged / skipped buckets", () => {
    const parsed = parseCsv(
      [
        CSV_HEADER.join(","),
        "NEW-1,Brand new,5000,pcs,false,true",
        "EXIST-1,Existing One,10000,pcs,false,true",
        "EXIST-1-RENAMED-PROBE,Existing renamed,10000,pcs,false,true",
        ",,bad,pcs,false,true",
      ].join("\n"),
    );

    // Add a row that matches an existing SKU but with a different price.
    const csv = [
      CSV_HEADER.join(","),
      "NEW-1,Brand new,5000,pcs,false,true",
      "EXIST-1,Existing One,12000,pcs,false,true",
      ",,bad,pcs,false,true",
    ].join("\n");
    const parsed2 = parseCsv(csv);
    const diff = diffAgainstCatalog(parsed2, existing);
    expect(diff.toCreate).toHaveLength(1);
    expect(diff.toCreate[0]!.draft.sku).toBe("NEW-1");
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0]!.draft.priceIdr).toBe(12000);
    expect(diff.toUpdate[0]!.existing.id).toBe("id-1");
    expect(diff.skipped).toHaveLength(1);

    // Sanity-check the unused parsed fixture compiles.
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("treats a re-imported identical row as unchanged (idempotency)", () => {
    const csv = [CSV_HEADER.join(","), "EXIST-1,Existing One,10000,pcs,false,true"].join("\n");
    const diff = diffAgainstCatalog(parseCsv(csv), existing);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });
});

describe("catalog-import: buildCsvTemplate", () => {
  it("emits a syntactically valid CSV with the documented header row", () => {
    const template = buildCsvTemplate();
    const parsed = parseCsv(template);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((r) => r.errors.length === 0)).toBe(true);
  });
});
