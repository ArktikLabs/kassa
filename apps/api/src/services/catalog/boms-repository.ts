export interface BomComponentRow {
  componentItemId: string;
  quantity: number;
  uomId: string;
}

export interface BomRow {
  id: string;
  merchantId: string;
  itemId: string;
  components: BomComponentRow[];
  updatedAt: Date;
}

export interface ListBomsInput {
  merchantId: string;
  updatedAfter?: Date;
  pageToken?: string | null;
  limit: number;
}

export interface ListBomsResult {
  records: BomRow[];
  nextCursor: Date | null;
  nextPageToken: string | null;
}

/**
 * Data plane for BOM headers + components (KASA-122). The pull response embeds
 * the component rows so the offline client can do BOM explosion locally; that
 * means `listBoms` returns `BomRow[]` with components already joined in.
 *
 * Reads are merchant-scoped via `boms.merchantId`. Components have no merchant
 * column of their own — the FK to `boms.id` carries the scoping for free.
 */
export interface BomsRepository {
  listBoms(input: ListBomsInput): Promise<ListBomsResult>;
}
