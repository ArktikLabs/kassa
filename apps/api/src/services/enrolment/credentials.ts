import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const API_KEY_PREFIX = "kk_dev_";

/**
 * Public, lookup-friendly device identifier returned to the client. Encodes
 * the device row's UUIDv7 in the `kk_dev_<base64url>` form so that the
 * device-auth middleware can recover the row id from the header value
 * without a separate index column.
 */
export function encodeApiKey(deviceId: string): string {
  const hex = deviceId.replaceAll("-", "");
  const bytes = Buffer.from(hex, "hex");
  return `${API_KEY_PREFIX}${bytes.toString("base64url")}`;
}

/**
 * Inverse of `encodeApiKey`. Returns null for any input that isn't a
 * `kk_dev_<base64url>` of exactly 16 bytes — including obvious garbage,
 * truncations, or values that decode to the wrong length. Callers must
 * still look up the device row; this only proves that the key is
 * well-formed enough to attempt a lookup.
 */
export function decodeApiKey(apiKey: string): string | null {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  const encoded = apiKey.slice(API_KEY_PREFIX.length);
  if (encoded.length === 0) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    return null;
  }
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function generateApiSecret(): string {
  return `kk_sec_${randomBytes(32).toString("base64url")}`;
}

/**
 * Argon2id parameters chosen to match OWASP 2023 minimums: 19 MiB memory,
 * 2 iterations, 1 lane. Tuned conservatively because device enrolment is a
 * once-per-tablet operation and we'd rather pay 50 ms here than skimp.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashApiSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2_OPTIONS);
}

export async function verifyApiSecret(hash: string, secret: string): Promise<boolean> {
  return argon2.verify(hash, secret);
}
