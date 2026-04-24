export type QrisOrderStatus =
  | "pending"
  | "paid"
  | "expired"
  | "cancelled"
  | "failed";

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

export interface NormalizedWebhookEvent {
  providerOrderId: string;
  status: QrisOrderStatus;
  grossAmount: number;
  signatureVerified: boolean;
  rawPayload: unknown;
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
