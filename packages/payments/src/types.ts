export type QrisOrderStatus = "pending" | "paid" | "expired" | "cancelled" | "failed";

export interface QrisOrderRequest {
  orderId: string;
  grossAmount: number;
  currency: "IDR";
  outletId: string;
  expiryMinutes?: number;
}

export interface QrisOrderResult {
  providerOrderId: string;
  qrString: string;
  qrImageUrl?: string;
  expiresAt?: string;
  rawResponse: unknown;
}

export interface QrisStatusResult {
  providerOrderId: string;
  status: QrisOrderStatus;
  grossAmount: number;
  paidAt?: string;
  rawResponse: unknown;
}

/**
 * Filter for `PaymentProvider.fetchQrisSettlements` (KASA-64).
 *
 * `businessDate` is the merchant's local calendar date (YYYY-MM-DD,
 * Asia/Jakarta) the EOD reconciliation pass is closing. The provider
 * adapter is responsible for translating that into whatever date filter
 * the upstream expects.
 *
 * `merchantId` is optional because Midtrans's settlement endpoint is
 * implicitly scoped to the API key's merchant; we still pass it through
 * for providers that require an explicit query parameter (DOKU, Xendit
 * v2 settlement APIs).
 */
export interface SettlementReportFilter {
  businessDate: string;
  merchantId?: string;
}

/**
 * One row of a payment provider's QRIS-static settlement report. The
 * EOD reconciliation matcher (apps/api/src/services/reconciliation) pairs
 * these against unverified `qris_static` tenders by `(outletId, last4,
 * grossAmountIdr)` inside a ±10-min window around `settledAt`.
 *
 * `last4` is the *last 4 digits* of the buyer's transfer reference. The
 * provider adapter extracts that from whatever upstream field exposes the
 * full reference (Midtrans: `va_numbers[].number` for VA-style refs, or
 * the QRIS-buyer-ref field for native QRIS rows).
 */
export interface SettlementReportRow {
  providerTransactionId: string;
  grossAmountIdr: number;
  last4: string;
  /** ISO-8601 with explicit offset (KASA-93 contract). */
  settledAt: string;
  outletId: string;
}

export interface NormalizedWebhookEvent {
  providerOrderId: string;
  status: QrisOrderStatus;
  grossAmount: number;
  signatureVerified: boolean;
  rawPayload: unknown;
  /**
   * ISO-8601 timestamp with an explicit timezone offset, so `new Date(occurredAt)`
   * is unambiguous across runtimes (ECMA-262 §21.4.3.2 leaves offset-less strings
   * implementation-defined). Providers MUST emit one of:
   * - `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC fallback, e.g. `2026-04-22T13:30:05.000Z`)
   * - `YYYY-MM-DDTHH:mm:ss±HH:MM` (explicit offset, e.g. `2026-04-22T20:30:00+07:00`)
   */
  occurredAt: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export class PaymentProviderError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export class WebhookSignatureError extends PaymentProviderError {
  constructor(message = "Webhook signature verification failed.") {
    super("webhook_signature_invalid", message, 401);
    this.name = "WebhookSignatureError";
  }
}
