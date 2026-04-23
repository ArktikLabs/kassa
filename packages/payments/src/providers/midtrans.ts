import { createHash, timingSafeEqual } from "node:crypto";
import type { PaymentProvider } from "../provider.js";
import {
  PaymentProviderError,
  WebhookSignatureError,
  type NormalizedWebhookEvent,
  type QrisOrderRequest,
  type QrisOrderResult,
  type QrisOrderStatus,
  type QrisStatusResult,
  type WebhookHeaders,
} from "../types.js";

export type MidtransEnvironment = "sandbox" | "production";

export interface MidtransConfig {
  serverKey: string;
  environment?: MidtransEnvironment;
  apiBaseUrl?: string;
  merchantId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface MidtransWebhookPayload {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
  transaction_status: string;
  transaction_id?: string;
  transaction_time?: string;
  fraud_status?: string;
  payment_type?: string;
  [key: string]: unknown;
}

const SANDBOX_BASE_URL = "https://api.sandbox.midtrans.com";
const PRODUCTION_BASE_URL = "https://api.midtrans.com";

export function createMidtransProvider(config: MidtransConfig): PaymentProvider {
  if (!config.serverKey || config.serverKey.trim() === "") {
    throw new PaymentProviderError(
      "missing_server_key",
      "Midtrans serverKey is required.",
    );
  }

  const environment: MidtransEnvironment = config.environment ?? "sandbox";
  const baseUrl =
    config.apiBaseUrl ??
    (environment === "production" ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const now = config.now ?? (() => new Date());

  if (typeof fetchImpl !== "function") {
    throw new PaymentProviderError(
      "missing_fetch",
      "No fetch implementation available; provide MidtransConfig.fetchImpl.",
    );
  }

  const authHeader = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;

  async function chargeQris(order: QrisOrderRequest): Promise<QrisOrderResult> {
    if (order.expiryMinutes !== undefined) {
      if (
        !Number.isInteger(order.expiryMinutes) ||
        order.expiryMinutes <= 0
      ) {
        throw new PaymentProviderError(
          "invalid_expiry_minutes",
          "expiryMinutes must be a positive integer.",
        );
      }
    }

    const body: Record<string, unknown> = {
      payment_type: "qris",
      transaction_details: {
        order_id: order.orderId,
        gross_amount: order.grossAmount,
      },
      qris: {
        acquirer: "gopay",
      },
      custom_field1: order.outletId,
    };

    if (order.expiryMinutes !== undefined) {
      body["custom_expiry"] = {
        order_time: formatJakartaTimestamp(now()),
        expiry_duration: order.expiryMinutes,
        unit: "minute",
      };
    }

    const response = await fetchImpl(`${baseUrl}/v2/charge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    const json = (await safeJson(response)) as Record<string, unknown>;

    if (!response.ok) {
      throw new PaymentProviderError(
        "midtrans_charge_failed",
        typeof json["status_message"] === "string"
          ? (json["status_message"] as string)
          : `Midtrans charge failed with status ${response.status}.`,
        response.status,
      );
    }

    const qrString = readQrString(json);
    if (qrString === null) {
      throw new PaymentProviderError(
        "midtrans_qr_missing",
        "Midtrans charge response did not include a QR string.",
      );
    }

    const expiresAt = typeof json["expiry_time"] === "string"
      ? (json["expiry_time"] as string)
      : undefined;
    const qrImageUrl = readQrImageUrl(json);

    const result: QrisOrderResult = {
      providerOrderId:
        typeof json["order_id"] === "string"
          ? (json["order_id"] as string)
          : order.orderId,
      qrString,
      rawResponse: json,
    };
    if (expiresAt !== undefined) result.expiresAt = expiresAt;
    if (qrImageUrl !== undefined) result.qrImageUrl = qrImageUrl;
    return result;
  }

  async function getStatus(orderId: string): Promise<QrisStatusResult> {
    const response = await fetchImpl(
      `${baseUrl}/v2/${encodeURIComponent(orderId)}/status`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: authHeader,
        },
      },
    );

    const json = (await safeJson(response)) as Record<string, unknown>;

    if (!response.ok) {
      throw new PaymentProviderError(
        "midtrans_status_failed",
        typeof json["status_message"] === "string"
          ? (json["status_message"] as string)
          : `Midtrans status query failed with status ${response.status}.`,
        response.status,
      );
    }

    const status = mapTransactionStatus(
      stringField(json, "transaction_status"),
      stringField(json, "fraud_status"),
    );
    const gross = parseAmount(stringField(json, "gross_amount"));

    const result: QrisStatusResult = {
      providerOrderId: stringField(json, "order_id") ?? orderId,
      status,
      grossAmount: gross,
      rawResponse: json,
    };
    const settledAt = stringField(json, "settlement_time") ?? stringField(json, "transaction_time");
    if (status === "paid" && settledAt !== undefined) {
      result.paidAt = settledAt;
    }
    return result;
  }

  function verifyWebhookSignature(
    payload: unknown,
    _headers: WebhookHeaders,
  ): NormalizedWebhookEvent {
    const parsed = parseWebhookPayload(payload);

    const expected = computeSignature(
      parsed.order_id,
      parsed.status_code,
      parsed.gross_amount,
      config.serverKey,
    );

    if (!timingSafeEqualHex(expected, parsed.signature_key)) {
      throw new WebhookSignatureError();
    }

    const status = mapTransactionStatus(
      parsed.transaction_status,
      parsed.fraud_status,
    );
    const occurredAt = parsed.transaction_time ?? now().toISOString();

    return {
      providerOrderId: parsed.order_id,
      status,
      grossAmount: parseAmount(parsed.gross_amount),
      signatureVerified: true,
      rawPayload: parsed,
      occurredAt,
    };
  }

  return {
    name: "midtrans",
    createQris: chargeQris,
    getQrisStatus: getStatus,
    verifyWebhookSignature,
  };
}

export function computeMidtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  serverKey: string,
): string {
  return computeSignature(orderId, statusCode, grossAmount, serverKey);
}

function computeSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  serverKey: string,
): string {
  return createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
    .digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseWebhookPayload(payload: unknown): MidtransWebhookPayload {
  if (!payload || typeof payload !== "object") {
    throw new WebhookSignatureError(
      "Webhook payload must be a JSON object.",
    );
  }
  const body = payload as Record<string, unknown>;
  const required = ["order_id", "status_code", "gross_amount", "signature_key", "transaction_status"] as const;
  for (const key of required) {
    if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
      throw new WebhookSignatureError(
        `Webhook payload missing required field '${key}'.`,
      );
    }
  }
  return body as MidtransWebhookPayload;
}

function mapTransactionStatus(
  transactionStatus: string | undefined,
  fraudStatus: string | undefined,
): QrisOrderStatus {
  switch (transactionStatus) {
    case "capture":
    case "settlement":
      return fraudStatus === "challenge" ? "pending" : "paid";
    case "pending":
      return "pending";
    case "deny":
    case "failure":
      return "failed";
    case "cancel":
      return "cancelled";
    case "expire":
      return "expired";
    case "refund":
    case "partial_refund":
    case "chargeback":
      return "cancelled";
    default:
      return "pending";
  }
}

function parseAmount(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function stringField(json: Record<string, unknown>, key: string): string | undefined {
  const v = json[key];
  return typeof v === "string" ? v : undefined;
}

function readQrString(json: Record<string, unknown>): string | null {
  const actions = json["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (
        action &&
        typeof action === "object" &&
        (action as Record<string, unknown>)["name"] === "generate-qr-code" &&
        typeof (action as Record<string, unknown>)["url"] === "string"
      ) {
        return (action as Record<string, unknown>)["url"] as string;
      }
    }
  }
  const direct = json["qr_string"];
  return typeof direct === "string" ? direct : null;
}

function readQrImageUrl(json: Record<string, unknown>): string | undefined {
  const actions = json["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (
        action &&
        typeof action === "object" &&
        (action as Record<string, unknown>)["name"] === "generate-qr-code" &&
        typeof (action as Record<string, unknown>)["url"] === "string"
      ) {
        return (action as Record<string, unknown>)["url"] as string;
      }
    }
  }
  return undefined;
}

// Midtrans `custom_expiry.order_time` must be formatted as
// `yyyy-MM-dd HH:mm:ss Z` in the merchant's local timezone. Indonesia observes
// no DST, so Asia/Jakarta is a fixed +0700 offset.
function formatJakartaTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} +0700`;
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
