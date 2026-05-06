import type { Sale, SaleTender, SalesRepository } from "../sales/index.js";
import type { SalesReader } from "./repository.js";
import type { SaleItem, SaleRecord, SaleTender as EodSaleTender } from "./types.js";

/*
 * Sole translation seam between the canonical KASA-66 `Sale` and the
 * EOD-domain `SaleRecord`. The wire-level tender enum the client sends
 * (`cash | qris | card | other`) gets widened on the EOD side so the
 * breakdown can distinguish webhook-verified `qris_dynamic` from the
 * unverified `qris_static` bucket. KASA-74 (payments reconciliation) is
 * the right place to start emitting `qris_dynamic`; until then every wire
 * `qris` is conservatively recorded as `qris_static` so the unverified
 * bucket stays truthful.
 */

export class SalesRepositorySalesReader implements SalesReader {
  constructor(private readonly repository: SalesRepository) {}

  async listSalesByBusinessDate(input: {
    merchantId: string;
    outletId: string;
    businessDate: string;
  }): Promise<readonly SaleRecord[]> {
    const sales = await this.repository.listSalesByBusinessDate(
      input.merchantId,
      input.outletId,
      input.businessDate,
    );
    return sales.map(toSaleRecord);
  }
}

function toSaleRecord(sale: Sale): SaleRecord {
  const items: SaleItem[] = sale.items.map((line) => ({
    itemId: line.itemId,
    quantity: line.quantity,
    unitPriceIdr: line.unitPriceIdr,
    lineTotalIdr: line.lineTotalIdr,
  }));
  const tenders: EodSaleTender[] = sale.tenders.map(toEodTender);
  return {
    saleId: sale.id,
    localSaleId: sale.localSaleId,
    merchantId: sale.merchantId,
    outletId: sale.outletId,
    clerkId: sale.clerkId,
    businessDate: sale.businessDate,
    createdAt: sale.createdAt,
    subtotalIdr: sale.subtotalIdr,
    discountIdr: sale.discountIdr,
    totalIdr: sale.totalIdr,
    taxIdr: sale.taxIdr,
    items,
    tenders,
    voidedAt: sale.voidedAt,
    synthetic: sale.synthetic,
  };
}

function toEodTender(tender: SaleTender): EodSaleTender {
  switch (tender.method) {
    case "qris":
      // Legacy wire-level QRIS without the dynamic/static distinction
      // (pre-KASA-121 outbox rows). Conservatively recorded as unverified
      // static so the variance report does not undercount the unverified
      // bucket. New POS clients emit the explicit `qris_static` case below.
      return {
        method: "qris_static",
        amountIdr: tender.amountIdr,
        reference: tender.reference,
        verified: false,
      };
    case "qris_static":
      return {
        method: "qris_static",
        amountIdr: tender.amountIdr,
        reference: tender.reference,
        // `qris_static` is unverified at write time; reconciliation flips
        // the persisted row server-side. The persisted `verified` value
        // wins if present so this reader stays correct after reconciliation.
        verified: tender.verified ?? false,
      };
    case "cash":
    case "card":
    case "other":
    case "synthetic":
      return {
        method: tender.method,
        amountIdr: tender.amountIdr,
        reference: tender.reference,
        // Non-QRIS tenders are server-vouched at submit time (cash drawer
        // count, card terminal approval, synthetic uptime probe); they
        // have no unverified window.
        verified: true,
      };
  }
}
