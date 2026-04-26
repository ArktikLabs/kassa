import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuidv7.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("emits an RFC 9562 UUIDv7 string", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
  });

  it("is lexicographically monotonic by timestamp", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it("encodes a 48-bit unix-ms timestamp in the leading bytes", () => {
    const now = 0x017f_7a00_0000; // well above the current millisecond range
    const id = uuidv7(now);
    const hex = id.replace(/-/g, "");
    const recovered = Number.parseInt(hex.slice(0, 12), 16);
    expect(recovered).toBe(now);
  });
});
