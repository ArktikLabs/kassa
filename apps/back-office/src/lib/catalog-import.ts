/*
 * CSV-import helpers for the catalog onboarding surface (KASA-311).
 *
 * Header is the user-friendly column set; the parser strips the UTF-8 BOM
 * (Excel writes one by default) and surfaces per-row validation errors so
 * the preview can flag bad rows before the user confirms the import.
 *
 * Columns we map to the existing CatalogItem shape:
 *   sku, name, price_idr, uom, is_stock_tracked, is_active
 *
 * Out of scope for v1 (file follow-ups when these schema fields land):
 *   name_id, category, tax_inclusive, modifiers_group, modifiers, image_url.
 * Unknown columns are passed through silently so a template with extra
 * columns from the merchant's existing menu spreadsheet doesn't crash the
 * import — they just don't influence the upsert.
 */

import { UNIT_OF_MEASURE_OPTIONS, type CatalogItem, type UnitOfMeasure } from "../data/types";

export const CSV_HEADER = [
  "sku",
  "name",
  "price_idr",
  "uom",
  "is_stock_tracked",
  "is_active",
] as const;

export type CsvColumn = (typeof CSV_HEADER)[number];

export const CSV_TEMPLATE_FILENAME = "kassa-catalog-template.csv";

export function buildCsvTemplate(): string {
  const lines = [
    CSV_HEADER.join(","),
    "NSI-001,Nasi Ayam,25000,porsi,false,true",
    "KOP-001,Kopi Susu,18000,pcs,false,true",
    "ES-001,Es Teh Manis,8000,pcs,false,true",
  ];
  return `${lines.join("\n")}\n`;
}

export type ParsedRow = {
  /** 1-indexed line number from the source CSV (header is line 1). */
  line: number;
  raw: Record<string, string>;
  /** `null` when any error fired; the import button stays disabled. */
  draft: Omit<CatalogItem, "id"> | null;
  errors: string[];
};

export type ParsedCsv = {
  header: string[];
  rows: ParsedRow[];
  /** File-level errors (e.g. missing header, bad encoding) that can't be tied to a row. */
  fileErrors: string[];
};

/** Strips a single UTF-8 BOM if present so Excel-exported CSVs parse cleanly. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC-4180-flavoured single-line parser. Honours quoted fields with embedded
 * commas and `""` escapes. Multiline quoted cells are rejected at the outer
 * `parseCsv` level — the back-office catalog doesn't need them and rejecting
 * keeps the per-line model simple.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let buf = "";
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    if (ch === '"' && buf === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  out.push(buf);
  return out;
}

function parseBoolean(input: string, fallback: boolean): { value: boolean; ok: boolean } {
  const v = input.trim().toLowerCase();
  if (v === "" || v === undefined) return { value: fallback, ok: true };
  if (v === "true" || v === "1" || v === "yes" || v === "y") return { value: true, ok: true };
  if (v === "false" || v === "0" || v === "no" || v === "n") return { value: false, ok: true };
  return { value: fallback, ok: false };
}

const UOM_SET = new Set<string>(UNIT_OF_MEASURE_OPTIONS);

function validateRow(raw: Record<string, string>): {
  draft: Omit<CatalogItem, "id"> | null;
  errors: string[];
} {
  const errors: string[] = [];
  const sku = (raw.sku ?? "").trim();
  if (sku.length === 0) errors.push("sku is required");
  if (sku.length > 64) errors.push("sku must be ≤ 64 characters");

  const name = (raw.name ?? "").trim();
  if (name.length === 0) errors.push("name is required");
  if (name.length > 256) errors.push("name must be ≤ 256 characters");

  const priceRaw = (raw.price_idr ?? "").trim();
  const price = Number(priceRaw);
  if (priceRaw === "") {
    errors.push("price_idr is required");
  } else if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
    errors.push("price_idr must be a non-negative integer");
  }

  const uomRaw = (raw.uom ?? "").trim();
  if (uomRaw === "") errors.push("uom is required");
  else if (!UOM_SET.has(uomRaw))
    errors.push(`uom must be one of: ${UNIT_OF_MEASURE_OPTIONS.join(", ")}`);

  const stock = parseBoolean(raw.is_stock_tracked ?? "", false);
  if (!stock.ok) errors.push("is_stock_tracked must be true/false");
  const active = parseBoolean(raw.is_active ?? "", true);
  if (!active.ok) errors.push("is_active must be true/false");

  if (errors.length > 0) return { draft: null, errors };

  return {
    draft: {
      sku,
      name,
      priceIdr: price,
      uom: uomRaw as UnitOfMeasure,
      imageUrl: null,
      isStockTracked: stock.value,
      availability: "available",
      isActive: active.value,
    },
    errors: [],
  };
}

const MAX_ROWS = 500;

export function parseCsv(text: string): ParsedCsv {
  const fileErrors: string[] = [];
  const sanitized = stripBom(text).replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
  const lines = sanitized.split("\n");

  if (lines.length === 0) {
    return { header: [], rows: [], fileErrors: ["The file is empty."] };
  }

  const headerLine = lines[0]!;
  const header = parseCsvLine(headerLine).map((c) => c.trim().toLowerCase());
  const missing = (CSV_HEADER as readonly string[]).filter((c) => !header.includes(c));
  if (missing.length > 0) {
    fileErrors.push(`Missing required column(s): ${missing.join(", ")}.`);
  }

  if (lines.length - 1 > MAX_ROWS) {
    fileErrors.push(`File has ${lines.length - 1} rows; batch cap is ${MAX_ROWS} rows.`);
  }

  const rows: ParsedRow[] = [];
  const seenSkus = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      rows.push({ line: i + 1, raw: {}, draft: null, errors: ["row is blank"] });
      continue;
    }
    const cells = parseCsvLine(line);
    const raw: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      raw[header[c]!] = cells[c] ?? "";
    }
    const { draft, errors } = validateRow(raw);
    const sku = (raw.sku ?? "").trim();
    if (sku !== "" && seenSkus.has(sku)) {
      errors.push(`duplicate sku ${sku} earlier in the file`);
    }
    if (sku !== "") seenSkus.add(sku);
    rows.push({
      line: i + 1,
      raw,
      draft: errors.length === 0 ? draft : null,
      errors,
    });
  }

  return { header, rows, fileErrors };
}

export type ImportDiff = {
  toCreate: Array<{ row: ParsedRow; draft: Omit<CatalogItem, "id"> }>;
  toUpdate: Array<{
    row: ParsedRow;
    draft: Omit<CatalogItem, "id">;
    existing: CatalogItem;
  }>;
  unchanged: Array<{ row: ParsedRow; existing: CatalogItem }>;
  skipped: ParsedRow[];
};

function isUnchanged(existing: CatalogItem, draft: Omit<CatalogItem, "id">): boolean {
  return (
    existing.sku === draft.sku &&
    existing.name === draft.name &&
    existing.priceIdr === draft.priceIdr &&
    existing.uom === draft.uom &&
    existing.isStockTracked === draft.isStockTracked &&
    existing.isActive === draft.isActive
  );
}

export function diffAgainstCatalog(
  parsed: ParsedCsv,
  existing: readonly CatalogItem[],
): ImportDiff {
  const bySku = new Map<string, CatalogItem>();
  for (const item of existing) bySku.set(item.sku, item);

  const toCreate: ImportDiff["toCreate"] = [];
  const toUpdate: ImportDiff["toUpdate"] = [];
  const unchanged: ImportDiff["unchanged"] = [];
  const skipped: ImportDiff["skipped"] = [];

  for (const row of parsed.rows) {
    if (!row.draft) {
      skipped.push(row);
      continue;
    }
    const match = bySku.get(row.draft.sku);
    if (!match) {
      toCreate.push({ row, draft: row.draft });
      continue;
    }
    if (isUnchanged(match, row.draft)) {
      unchanged.push({ row, existing: match });
      continue;
    }
    toUpdate.push({ row, draft: row.draft, existing: match });
  }

  return { toCreate, toUpdate, unchanged, skipped };
}
