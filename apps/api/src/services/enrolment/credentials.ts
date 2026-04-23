import { randomBytes } from "node:crypto";
import argon2 from "argon2";

/**
 * Public, lookup-friendly device identifier returned to the client. Encodes
 * the device row's UUIDv7 in the `kk_dev_<base64url>` form so that future
 * device-auth middleware (KASA-25) can recover the row id from the header
 * value without a separate index column.
 */
export function encodeApiKey(deviceId: string): string {
  const hex = deviceId.replaceAll("-", "");
  const bytes = Buffer.from(hex, "hex");
  return `kk_dev_${bytes.toString("base64url")}`;
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
