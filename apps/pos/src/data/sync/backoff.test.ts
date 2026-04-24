import { describe, expect, it } from "vitest";
import { computeBackoffMs, sleep } from "./backoff.ts";

describe("computeBackoffMs", () => {
  it("returns 0 for attempt < 1", () => {
    expect(computeBackoffMs(0, { random: () => 0.5 })).toBe(0);
  });

  it("scales exponentially up to the cap and multiplies by the jitter", () => {
    const rand = () => 0.999;
    expect(computeBackoffMs(1, { baseMs: 1000, capMs: 60_000, random: rand })).toBe(999);
    expect(computeBackoffMs(2, { baseMs: 1000, capMs: 60_000, random: rand })).toBe(1998);
    expect(computeBackoffMs(7, { baseMs: 1000, capMs: 60_000, random: rand })).toBe(59_940);
  });

  it("caps the jitter window at capMs", () => {
    expect(
      computeBackoffMs(20, { baseMs: 1000, capMs: 60_000, random: () => 0.99 }),
    ).toBeLessThanOrEqual(60_000);
  });
});

describe("sleep", () => {
  it("aborts when the signal fires", async () => {
    const ctrl = new AbortController();
    const p = sleep(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(DOMException);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleep(1000, ctrl.signal)).rejects.toBeInstanceOf(DOMException);
  });
});
