import { describe, expect, it } from "vitest";
import {
  EOD_CSV_BOM,
  EOD_CSV_COLUMNS,
  EOD_CSV_LINE_ENDING,
  EOD_CSV_SEPARATOR,
  buildEodCsv,
  eodCsvFilename,
  outletSlug,
  type EodCsvInput,
} from "../src/services/eod/csv.js";

const baseInput: EodCsvInput = {
  eod: {
    id: "01890abc-1234-7def-8000-0000000eee01",
    outletId: "01890abc-1234-7def-8000-000000000001",
    merchantId: "01890abc-1234-7def-8000-00000000a001",
    businessDate: "2026-04-23",
    closedAt: "2026-04-23T18:30:00+07:00",
    countedCashIdr: 1_250_000,
    expectedCashIdr: 1_240_000,
    openingFloatIdr: 100_000,
    varianceIdr: 10_000,
    varianceReason: "kembalian dititip",
    breakdown: {
      saleCount: 42,
      voidCount: 1,
      cashIdr: 1_240_000,
      qrisDynamicIdr: 500_000,
      qrisStaticIdr: 300_000,
      qrisStaticUnverifiedIdr: 50_000,
      qrisStaticUnverifiedCount: 1,
      cardIdr: 0,
      otherIdr: 0,
      netIdr: 2_040_000,
      taxIdr: 200_000,
    },
    clientSaleIds: [],
  },
  outlet: { name: "Warung Pusat", code: "JKT-01" },
  shift: {
    openedAt: "2026-04-23T07:00:00+07:00",
    closedAt: "2026-04-23T18:30:00+07:00",
    cashier: "Budi Santoso",
  },
};

describe("buildEodCsv (KASA-250)", () => {
  it("starts with a UTF-8 BOM so Excel-id reads it as UTF-8 by default", () => {
    const csv = buildEodCsv(baseInput);
    expect(csv.startsWith(EOD_CSV_BOM)).toBe(true);
    // BOM is exactly one code point of three UTF-8 bytes (0xEF 0xBB 0xBF).
    const buf = Buffer.from(csv, "utf8");
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it("uses `;` as the field separator and CRLF as the row terminator", () => {
    const csv = buildEodCsv(baseInput);
    const body = csv.slice(EOD_CSV_BOM.length);
    const lines = body.split(EOD_CSV_LINE_ENDING);
    // header + data + trailing empty (from final CRLF)
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(lines[0]?.split(EOD_CSV_SEPARATOR)).toHaveLength(EOD_CSV_COLUMNS.length);
    expect(lines[1]?.split(EOD_CSV_SEPARATOR)).toHaveLength(EOD_CSV_COLUMNS.length);
  });

  it("emits the documented column order in the header row", () => {
    const csv = buildEodCsv(baseInput);
    const body = csv.slice(EOD_CSV_BOM.length);
    const header = body.split(EOD_CSV_LINE_ENDING)[0];
    expect(header).toBe(EOD_CSV_COLUMNS.join(EOD_CSV_SEPARATOR));
  });

  it("renders numeric columns as plain integer rupiah (no separator, no decimals)", () => {
    const csv = buildEodCsv(baseInput);
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataRow = body.split(EOD_CSV_LINE_ENDING)[1]?.split(EOD_CSV_SEPARATOR) ?? [];
    const byCol = new Map(EOD_CSV_COLUMNS.map((col, i) => [col, dataRow[i]]));
    expect(byCol.get("expected_cash")).toBe("1240000");
    expect(byCol.get("counted_cash")).toBe("1250000");
    expect(byCol.get("cash_variance")).toBe("10000");
    expect(byCol.get("ppn")).toBe("200000");
    // `netIdr` is the customer-paid gross (sum of `sale.totalIdr`);
    // `gross` mirrors it and `net` is the tax base (netIdr − taxIdr).
    expect(byCol.get("gross")).toBe("2040000");
    expect(byCol.get("net")).toBe("1840000");
    expect(byCol.get("sale_count")).toBe("42");
    expect(byCol.get("void_count")).toBe("1");
  });

  it("sums QRIS dynamic + static into expected_qris and removes the unverified slice for settled_qris", () => {
    const csv = buildEodCsv(baseInput);
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataRow = body.split(EOD_CSV_LINE_ENDING)[1]?.split(EOD_CSV_SEPARATOR) ?? [];
    const byCol = new Map(EOD_CSV_COLUMNS.map((col, i) => [col, dataRow[i]]));
    // expected = 500k dynamic + 300k static = 800k; settled = expected − 50k unverified
    expect(byCol.get("expected_qris")).toBe("800000");
    expect(byCol.get("settled_qris")).toBe("750000");
    expect(byCol.get("qris_variance")).toBe("50000");
  });

  it("renders a cash-short close as a signed negative integer", () => {
    const csv = buildEodCsv({
      ...baseInput,
      eod: { ...baseInput.eod, countedCashIdr: 1_230_000, varianceIdr: -10_000 },
    });
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataRow = body.split(EOD_CSV_LINE_ENDING)[1]?.split(EOD_CSV_SEPARATOR) ?? [];
    const cashVarIdx = EOD_CSV_COLUMNS.indexOf("cash_variance");
    expect(dataRow[cashVarIdx]).toBe("-10000");
  });

  it('RFC-4180 quotes fields that contain `;`, `"`, or newlines', () => {
    const csv = buildEodCsv({
      ...baseInput,
      outlet: { name: 'Warung "Pak; Budi"\nCabang', code: "JKT-01" },
    });
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataLine = body.split(EOD_CSV_LINE_ENDING)[1] ?? "";
    // The outlet column is the first cell — extract the leading quoted
    // field. Inner double-quotes are doubled per RFC-4180.
    expect(dataLine.startsWith('"Warung ""Pak; Budi""\nCabang";')).toBe(true);
  });

  it("does not quote plain strings (defensive against over-quoting)", () => {
    const csv = buildEodCsv(baseInput);
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataLine = body.split(EOD_CSV_LINE_ENDING)[1] ?? "";
    expect(dataLine.startsWith("Warung Pusat;")).toBe(true);
  });

  it("renders shift columns as empty strings when no shift row was found", () => {
    const csv = buildEodCsv({ ...baseInput, shift: null });
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataRow = body.split(EOD_CSV_LINE_ENDING)[1]?.split(EOD_CSV_SEPARATOR) ?? [];
    const byCol = new Map(EOD_CSV_COLUMNS.map((col, i) => [col, dataRow[i]]));
    expect(byCol.get("shift_open_at")).toBe("");
    expect(byCol.get("cashier")).toBe("");
    // shift_close_at falls back to the EOD close timestamp so the
    // bookkeeper still gets a close stamp for pre-KASA-235 closes.
    expect(byCol.get("shift_close_at")).toBe("2026-04-23T18:30:00+07:00");
  });

  it("falls back to the EOD close timestamp when the shift row is open-ended", () => {
    const csv = buildEodCsv({
      ...baseInput,
      shift: { openedAt: "2026-04-23T07:00:00+07:00", closedAt: null, cashier: "Budi" },
    });
    const body = csv.slice(EOD_CSV_BOM.length);
    const dataRow = body.split(EOD_CSV_LINE_ENDING)[1]?.split(EOD_CSV_SEPARATOR) ?? [];
    const closeIdx = EOD_CSV_COLUMNS.indexOf("shift_close_at");
    expect(dataRow[closeIdx]).toBe("2026-04-23T18:30:00+07:00");
  });
});

describe("outletSlug / eodCsvFilename", () => {
  it("lowercases and collapses non-alphanumerics so codes become URL/file-safe slugs", () => {
    expect(outletSlug("JKT-01")).toBe("jkt-01");
    expect(outletSlug("Warung Pusat / Cabang #3")).toBe("warung-pusat-cabang-3");
    expect(outletSlug("---")).toBe("outlet");
    expect(outletSlug("")).toBe("outlet");
  });

  it("renders the documented filename shape `kassa-eod-{slug}-{YYYY-MM-DD}.csv`", () => {
    expect(eodCsvFilename("JKT-01", "2026-04-23")).toBe("kassa-eod-jkt-01-2026-04-23.csv");
  });
});
