import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

/**
 * Crowd-style alphabet (Crockford-ish): no 0/1/I/L/O — these are the characters
 * a cashier reads aloud and a clerk types onto a tablet. 32 symbols ^ 8 chars
 * ≈ 1.1 × 10^12 codes; with a 10-minute TTL and aggressive rate-limiting, the
 * online-guess surface is negligible. Codes are unique per row in
 * `enrolment_codes` so collisions are caught at insert time.
 */
export function generateEnrolmentCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}
