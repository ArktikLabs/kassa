import { randomBytes } from "node:crypto";

/**
 * RFC 9562 UUIDv7. 48-bit unix-ms timestamp + 74 bits of randomness, with the
 * version (7) and variant (10) bits in their canonical positions. Sortable by
 * insertion time, which is the property we want for index locality on the
 * `devices` table.
 */
export function uuidv7(now: number = Date.now()): string {
  const random = randomBytes(10);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | (random.readUInt8(0) & 0x0f);
  bytes[7] = random.readUInt8(1);
  bytes[8] = 0x80 | (random.readUInt8(2) & 0x3f);
  bytes[9] = random.readUInt8(3);
  random.copy(bytes, 10, 4, 10);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
