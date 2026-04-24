import type {
  NormalizedWebhookEvent,
  QrisOrderRequest,
  QrisOrderResult,
  QrisStatusResult,
  WebhookHeaders,
} from "./types.js";

export interface PaymentProvider {
  readonly name: string;

  createQris(order: QrisOrderRequest): Promise<QrisOrderResult>;

  getQrisStatus(orderId: string): Promise<QrisStatusResult>;

  verifyWebhookSignature(
    payload: unknown,
    headers: WebhookHeaders,
  ): NormalizedWebhookEvent;
}
