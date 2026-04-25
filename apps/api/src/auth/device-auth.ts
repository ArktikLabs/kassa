import type { FastifyReply, FastifyRequest } from "fastify";
import type { Device } from "../db/schema/devices.js";
import { sendError } from "../lib/errors.js";
import { decodeApiKey, verifyApiSecret } from "../services/enrolment/credentials.js";

declare module "fastify" {
  interface FastifyRequest {
    devicePrincipal?: {
      deviceId: string;
      merchantId: string;
      outletId: string;
    };
  }
}

export type DeviceAuthPreHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | undefined>;

/**
 * Read-only view of the device row that the auth middleware needs. Kept
 * narrow so the route layer doesn't accidentally couple to enrolment-only
 * fields (`createdAt`, `fingerprint`, etc.) that Drizzle returns alongside.
 */
export interface DeviceAuthRecord {
  id: string;
  merchantId: string;
  outletId: string;
  apiKeyHash: string;
  status: Device["status"];
}

export interface DeviceAuthRepository {
  findDevice(deviceId: string): Promise<DeviceAuthRecord | null>;
  /**
   * Best-effort `last_seen_at` bump. Called fire-and-forget after a
   * successful auth so a slow update never delays the request, and so a
   * write failure never turns an authenticated request into a 500.
   */
  touchDevice(deviceId: string, seenAt: Date): Promise<void>;
}

export interface DeviceAuthDeps {
  repository: DeviceAuthRepository;
  now?: () => Date;
  /**
   * Hook for tests that need to await the otherwise fire-and-forget
   * `touchDevice` write. Production callers should leave this unset.
   */
  onTouchSettled?: (result: PromiseSettledResult<void>) => void;
}

/**
 * Builds the Fastify preHandler that authenticates a device via HTTP Basic
 * with the credentials returned from `POST /v1/auth/enroll`:
 *
 *   Authorization: Basic base64(<apiKey>:<apiSecret>)
 *
 * On success the principal is exposed at `req.devicePrincipal`. On any
 * failure the response is 401 with `{ error: { code: "unauthorized" } }`
 * — the specific reason is never leaked to the caller (only logged) so a
 * probe can't distinguish "unknown device" from "wrong secret".
 */
export function makeDeviceAuthPreHandler(deps: DeviceAuthDeps): DeviceAuthPreHandler {
  const now = deps.now ?? (() => new Date());
  return async function requireDeviceAuth(req, reply) {
    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials) {
      return unauthorized(req, reply, "missing_or_malformed_basic_auth");
    }

    const deviceId = decodeApiKey(credentials.apiKey);
    if (!deviceId) {
      return unauthorized(req, reply, "api_key_not_decodable");
    }

    let device: DeviceAuthRecord | null;
    try {
      device = await deps.repository.findDevice(deviceId);
    } catch (err) {
      req.log.error({ err, deviceId }, "device-auth lookup failed");
      throw err;
    }
    if (!device) {
      return unauthorized(req, reply, "device_not_found", { deviceId });
    }
    if (device.status !== "active") {
      return unauthorized(req, reply, "device_not_active", {
        deviceId,
        status: device.status,
      });
    }

    let secretValid: boolean;
    try {
      secretValid = await verifyApiSecret(device.apiKeyHash, credentials.apiSecret);
    } catch (err) {
      // argon2 throws on malformed hashes; treat as auth failure rather than
      // 500 so a corrupt row in `devices` can't take the whole route down.
      req.log.error({ err, deviceId }, "device-auth secret verify threw");
      return unauthorized(req, reply, "secret_verify_threw", { deviceId });
    }
    if (!secretValid) {
      return unauthorized(req, reply, "secret_mismatch", { deviceId });
    }

    req.devicePrincipal = {
      deviceId: device.id,
      merchantId: device.merchantId,
      outletId: device.outletId,
    };

    const touched = deps.repository.touchDevice(device.id, now()).catch((err: unknown) => {
      req.log.warn({ err, deviceId: device.id }, "device touch failed");
    });
    if (deps.onTouchSettled) {
      void touched.then(
        () => deps.onTouchSettled?.({ status: "fulfilled", value: undefined }),
        (reason: unknown) => deps.onTouchSettled?.({ status: "rejected", reason }),
      );
    }

    return undefined;
  };
}

function unauthorized(
  req: FastifyRequest,
  reply: FastifyReply,
  reason: string,
  context?: Record<string, unknown>,
): FastifyReply {
  req.log.info({ event: "device_auth.rejected", reason, ...context }, "device auth rejected");
  return sendError(reply, 401, "unauthorized", "Device credentials required.");
}

function parseBasicAuth(
  header: string | string[] | undefined,
): { apiKey: string; apiSecret: string } | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") return null;
  const prefix = "Basic ";
  if (!value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length).trim();
  if (encoded.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0 || sep === decoded.length - 1) return null;
  return {
    apiKey: decoded.slice(0, sep),
    apiSecret: decoded.slice(sep + 1),
  };
}
