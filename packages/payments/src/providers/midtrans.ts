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
  type SettlementReportFilter,
  type SettlementReportRow,
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
  /** Outbound HTTP timeout per call, in ms. Defaults to 10_000. */
  requestTimeoutMs?: number;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function createMidtransProvider(config: MidtransConfig): PaymentProvider {
  if (!config.serverKey || config.serverKey.trim() === "") {
    throw new PaymentProviderError("missing_server_key", "Midtrans serverKey is required.");
  }

  const environment: MidtransEnvironment = config.environment ?? "sandbox";
  const baseUrl =
    config.apiBaseUrl ?? (environment === "production" ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const now = config.now ?? (() => new Date());
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  if (typeof fetchImpl !== "function") {
    throw new PaymentProviderError(
      "missing_fetch",
      "No fetch implementation available; provide MidtransConfig.fetchImpl.",
    );
  }

  const authHeader = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;

  async function withTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) {
        throw new PaymentProviderError(
          "midtrans_timeout",
          `Midtrans request exceeded ${requestTimeoutMs}ms.`,
          504,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chargeQris(order: QrisOrderRequest): Promise<QrisOrderResult> {
    if (order.expiryMinutes !== undefined) {
      if (!Number.isInteger(order.expiryMinutes) || order.expiryMinutes <= 0) {
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
      body.custom_expiry = {
        order_time: formatJakartaTimestamp(now()),
        expiry_duration: order.expiryMinutes,
        unit: "minute",
      };
    }

    const response = await withTimeout(`${baseUrl}/v2/charge`, {
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
        typeof json.status_message === "string"
          ? (json.status_message as string)
          : `Midtrans charge failed with status ${response.status}.`,
        response.status,
      );
    }

    const qrString = readQrString(json);
    if (qrString === null) {
      throw new PaymentProviderError(
        "midtrans_qr_missing",
        "Midtrans charge response did not include a qr_string.",
      );
    }

    const expiresAt =
      typeof json.expiry_time === "string" ? (json.expiry_time as string) : undefined;
    const qrImageUrl = readQrImageUrl(json);

    const result: QrisOrderResult = {
      providerOrderId:
        typeof json.order_id === "string" ? (json.order_id as string) : order.orderId,
      qrString,
      rawResponse: json,
    };
    if (expiresAt !== undefined) result.expiresAt = expiresAt;
    if (qrImageUrl !== undefined) result.qrImageUrl = qrImageUrl;
    return result;
  }

  async function getStatus(orderId: string): Promise<QrisStatusResult> {
    const response = await withTimeout(`${baseUrl}/v2/${encodeURIComponent(orderId)}/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
    });

    const json = (await safeJson(response)) as Record<string, unknown>;

    if (!response.ok) {
      throw new PaymentProviderError(
        "midtrans_status_failed",
        typeof json.status_message === "string"
          ? (json.status_message as string)
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

    const status = mapTransactionStatus(parsed.transaction_status, parsed.fraud_status);
    const occurredAt = resolveOccurredAt(parsed.transaction_time, now());

    return {
      providerOrderId: parsed.order_id,
      status,
      grossAmount: parseAmount(parsed.gross_amount),
      signatureVerified: true,
      rawPayload: parsed,
      occurredAt,
    };
  }

  async function fetchQrisSettlements(
    filter: SettlementReportFilter,
  ): Promise<readonly SettlementReportRow[]> {
    if (!BUSINESS_DATE_RE.test(filter.businessDate)) {
      throw new PaymentProviderError(
        "invalid_business_date",
        `businessDate must be YYYY-MM-DD; got ${JSON.stringify(filter.businessDate)}.`,
      );
    }

    // Midtrans Iris/Settlement reporting endpoint. Filtering by `from`/`to`
    // on the same business date pulls every row that posted on that local
    // calendar day; pagination uses `page`/`count`. We page until the
    // response returns fewer than `PAGE_SIZE` rows.
    const rows: SettlementReportRow[] = [];
    let page = 1;
    while (page <= MAX_SETTLEMENT_PAGES) {
      const url = new URL(`${baseUrl}/v1/payouts/settlement`);
      url.searchParams.set("from", filter.businessDate);
      url.searchParams.set("to", filter.businessDate);
      url.searchParams.set("payment_type", "qris");
      url.searchParams.set("page", String(page));
      url.searchParams.set("count", String(PAGE_SIZE));
      if (filter.merchantId !== undefined) {
        url.searchParams.set("merchant_id", filter.merchantId);
      }

      const response = await withTimeout(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: authHeader,
        },
      });

      const json = (await safeJson(response)) as Record<string, unknown>;
      if (!response.ok) {
        throw new PaymentProviderError(
          "midtrans_settlement_failed",
          typeof json.status_message === "string"
            ? (json.status_message as string)
            : `Midtrans settlement query failed with status ${response.status}.`,
          response.status,
        );
      }

      const data = Array.isArray(json.data) ? json.data : [];
      for (const raw of data) {
        const parsed = parseSettlementRow(raw);
        if (parsed !== null) rows.push(parsed);
      }
      if (data.length < PAGE_SIZE) break;
      page += 1;
    }
    return rows;
  }

  return {
    name: "midtrans",
    createQris: chargeQris,
    getQrisStatus: getStatus,
    verifyWebhookSignature,
    fetchQrisSettlements,
  };
}

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 200;
// Hard cap so a misbehaving upstream that never decrements row count can't
// drive the worker into an infinite loop. 50 pages × 200 rows = 10k QRIS
// settlements per merchant per day, far past any plausible v0 volume.
const MAX_SETTLEMENT_PAGES = 50;

function parseSettlementRow(raw: unknown): SettlementReportRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const providerTransactionId = stringField(row, "transaction_id");
  if (providerTransactionId === undefined) return null;
  const grossAmountIdr = parseAmount(stringField(row, "gross_amount"));
  const settledAtRaw = stringField(row, "settlement_time") ?? stringField(row, "transaction_time");
  if (settledAtRaw === undefined) return null;
  const settledAt = jakartaTimestampToIsoOffset(settledAtRaw) ?? settledAtRaw;
  const last4 = extractLast4(row);
  if (last4 === null) return null;
  const outletId = stringField(row, "custom_field1");
  if (outletId === undefined) return null;
  return {
    providerTransactionId,
    grossAmountIdr,
    last4,
    settledAt,
    outletId,
  };
}

// Midtrans's QRIS settlement row exposes the buyer's reference under
// `transaction_reference` (preferred), `reference_id`, or — for VA-shaped
// flows that ride on top of QRIS — the trailing digits of `va_numbers[0].number`.
// We pick the first of these that exists and last-4 it.
function extractLast4(row: Record<string, unknown>): string | null {
  const fromTxnRef = lastFour(stringField(row, "transaction_reference"));
  if (fromTxnRef !== null) return fromTxnRef;
  const fromRefId = lastFour(stringField(row, "reference_id"));
  if (fromRefId !== null) return fromRefId;
  const vaNumbers = row.va_numbers;
  if (Array.isArray(vaNumbers) && vaNumbers.length > 0) {
    const first = vaNumbers[0];
    if (first && typeof first === "object") {
      const number =
        (first as Record<string, unknown>).va_number ?? (first as Record<string, unknown>).number;
      const fromVa = lastFour(typeof number === "string" ? number : undefined);
      if (fromVa !== null) return fromVa;
    }
  }
  return null;
}

function lastFour(raw: string | undefined): string | null {
  if (!raw) return null;
  const digitsOnly = raw.replace(/\D/g, "");
  if (digitsOnly.length < 4) return null;
  return digitsOnly.slice(-4);
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
    throw new WebhookSignatureError("Webhook payload must be a JSON object.");
  }
  const body = payload as Record<string, unknown>;
  const required = [
    "order_id",
    "status_code",
    "gross_amount",
    "signature_key",
    "transaction_status",
  ] as const;
  for (const key of required) {
    if (typeof body[key] !== "string" || (body[key] as string).length === 0) {
      throw new WebhookSignatureError(`Webhook payload missing required field '${key}'.`);
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
      if (fraudStatus === "challenge") return "pending";
      if (fraudStatus === "deny") return "failed";
      return "paid";
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

// Midtrans `gross_amount` is always a decimal string ("25000" / "25000.00").
// Silently coercing a malformed value to 0 would let a paid event fire with the
// wrong total, so we reject non-numeric input and let the caller surface a 4xx.
const AMOUNT_RE = /^\d+(\.\d+)?$/;

function parseAmount(raw: string | undefined): number {
  if (raw === undefined || !AMOUNT_RE.test(raw)) {
    throw new PaymentProviderError(
      "invalid_gross_amount",
      `Expected a decimal string for gross_amount; got ${raw === undefined ? "undefined" : JSON.stringify(raw)}.`,
    );
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new PaymentProviderError(
      "invalid_gross_amount",
      `gross_amount '${raw}' did not parse to a finite number.`,
    );
  }
  return n;
}

function stringField(json: Record<string, unknown>, key: string): string | undefined {
  const v = json[key];
  return typeof v === "string" ? v : undefined;
}

// Midtrans returns the EMV-compatible payload in `qr_string` and a rendered
// PNG endpoint in `actions[name="generate-qr-code"].url`. Consumers that need
// to render the QR offline require the EMV string; the URL is for clients that
// want Midtrans to render it.
function readQrString(json: Record<string, unknown>): string | null {
  const direct = json.qr_string;
  return typeof direct === "string" ? direct : null;
}

function readQrImageUrl(json: Record<string, unknown>): string | undefined {
  const actions = json.actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (
        action &&
        typeof action === "object" &&
        (action as Record<string, unknown>).name === "generate-qr-code" &&
        typeof (action as Record<string, unknown>).url === "string"
      ) {
        return (action as Record<string, unknown>).url as string;
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

// Midtrans `transaction_time` arrives as `YYYY-MM-DD HH:mm:ss` in Asia/Jakarta
// with no timezone suffix. Parsing that shape via `new Date(...)` is
// implementation-defined (ECMA-262 §21.4.3.2), so we reformat to an
// offset-aware ISO-8601 string and fall back to the caller's UTC clock if
// Midtrans ever sends something we can't parse. Indonesia observes no DST, so
// Asia/Jakarta is a fixed +07:00 offset.
const JAKARTA_TRANSACTION_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function resolveOccurredAt(raw: string | undefined, fallback: Date): string {
  if (raw !== undefined) {
    const iso = jakartaTimestampToIsoOffset(raw);
    if (iso !== null) return iso;
  }
  return fallback.toISOString();
}

function jakartaTimestampToIsoOffset(raw: string): string | null {
  const m = JAKARTA_TRANSACTION_TIME_RE.exec(raw);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+07:00`;
  if (!Number.isFinite(Date.parse(iso))) return null;
  return iso;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
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
