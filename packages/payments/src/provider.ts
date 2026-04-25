import type {
  NormalizedWebhookEvent,
  QrisOrderRequest,
  QrisOrderResult,
  QrisStatusResult,
  SettlementReportFilter,
  SettlementReportRow,
  WebhookHeaders,
} from "./types.js";

export interface PaymentProvider {
  readonly name: string;

  createQris(order: QrisOrderRequest): Promise<QrisOrderResult>;

  getQrisStatus(orderId: string): Promise<QrisStatusResult>;

  verifyWebhookSignature(payload: unknown, headers: WebhookHeaders): NormalizedWebhookEvent;

  /**
   * Fetch the QRIS-static settlement rows the provider posted on
   * `filter.businessDate`. Powers the EOD reconciliation pass that flips
   * unverified static-QRIS tenders to `verified=true`.
   */
  fetchQrisSettlements(filter: SettlementReportFilter): Promise<readonly SettlementReportRow[]>;
}
