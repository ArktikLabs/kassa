/**
 * RFC 9562 UUIDv7 generator for the browser (mirrors `apps/api/src/lib/uuid.ts`).
 *
 * 48-bit unix-ms timestamp + 74 bits of randomness, with the version (7) and
 * variant (10) bits in their canonical positions. ARCHITECTURE.md ADR-004 pins
 * `local_sale_id` to UUIDv7 so duplicate pushes retry-collapse on the server.
 *
 * Uses `crypto.getRandomValues` — a service-worker-safe, synchronous source of
 * randomness that ships in every PWA target browser.
 */
export function uuidv7(now: number = Date.now()): string {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);

  const bytes: number[] = new Array<number>(16);
  // 48-bit big-endian unix-ms timestamp.
  const hi = Math.floor(now / 0x1_0000_0000);
  const lo = now >>> 0;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  // Version 7 (0b0111) in the top nibble of byte 6.
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  bytes[7] = random[1] ?? 0;
  // Variant 10xxxxxx in byte 8.
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  for (let i = 3; i < 10; i += 1) {
    bytes[9 + (i - 3)] = random[i] ?? 0;
  }

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
