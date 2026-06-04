import { describe, expect, it } from "vitest";
import { hashAccountId, hashesEqual, hashIp, nextLockout } from "../src/auth/login-lockout.js";
import { InMemoryLoginAttemptsRepository } from "../src/services/login-attempts/index.js";

/*
 * Pure-function unit tests for the lockout policy + HMAC helpers
 * (KASA-312). Kept separate from the integration suite so a regression
 * here surfaces before the full Fastify boot.
 */

describe("nextLockout", () => {
  it("returns null below the 5-failure threshold so the route attempts the verify", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(nextLockout(i), `expected no lockout at ${i} fails`).toBeNull();
    }
  });

  it("ticks to 30 seconds at the 5th consecutive failure", () => {
    expect(nextLockout(5)).toEqual({ durationSeconds: 30 });
    expect(nextLockout(9)).toEqual({ durationSeconds: 30 });
  });

  it("escalates to 5 minutes at the 10th failure", () => {
    expect(nextLockout(10)).toEqual({ durationSeconds: 300 });
    expect(nextLockout(14)).toEqual({ durationSeconds: 300 });
  });

  it("escalates to 1 hour at the 15th failure and stays there for higher counts", () => {
    expect(nextLockout(15)).toEqual({ durationSeconds: 3600 });
    expect(nextLockout(50)).toEqual({ durationSeconds: 3600 });
  });
});

describe("hashAccountId / hashIp", () => {
  const SECRET = "super-secret-hmac-key-at-least-32-chars-long";

  it("emits stable base64url hashes for the same input", () => {
    const a = hashAccountId("owner@kassa.id", SECRET);
    const b = hashAccountId("owner@kassa.id", SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes when the secret rotates so a leaked digest can't be cross-referenced", () => {
    const a = hashAccountId("owner@kassa.id", SECRET);
    const b = hashAccountId("owner@kassa.id", `${SECRET}-rotated`);
    expect(a).not.toBe(b);
  });

  it("treats the input as opaque bytes — the caller is responsible for normalization", () => {
    const lower = hashAccountId("owner@kassa.id", SECRET);
    const upper = hashAccountId("OWNER@KASSA.ID", SECRET);
    // The function itself does NOT lowercase; route normalizes first.
    expect(lower).not.toBe(upper);
  });

  it("hashes IP addresses with the same shape so the audit row carries no plaintext", () => {
    const v4 = hashIp("203.0.113.7", SECRET);
    const v6 = hashIp("2001:db8::1", SECRET);
    expect(v4).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v6).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v4).not.toBe(v6);
  });

  it("hashesEqual is true for matching digests and false otherwise", () => {
    const a = hashAccountId("a@x", SECRET);
    const b = hashAccountId("a@x", SECRET);
    const c = hashAccountId("b@x", SECRET);
    expect(hashesEqual(a, b)).toBe(true);
    expect(hashesEqual(a, c)).toBe(false);
  });
});

describe("InMemoryLoginAttemptsRepository", () => {
  it("counts consecutive failures since the last success", async () => {
    const repo = new InMemoryLoginAttemptsRepository();
    const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs);
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: at(0),
    });
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: at(1),
    });
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: at(2),
    });
    const after3 = await repo.summarizeAccount("acct");
    expect(after3.consecutiveFails).toBe(3);
    expect(after3.lastFailureAt).toEqual(at(2));

    // A success resets the counter — the next summarize walks back from
    // newest and stops at the success boundary.
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: true,
      attemptedAt: at(3),
    });
    const afterSuccess = await repo.summarizeAccount("acct");
    expect(afterSuccess.consecutiveFails).toBe(0);
    expect(afterSuccess.lastFailureAt).toBeNull();

    // Failures after the success start the staircase again from 1.
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: at(4),
    });
    const after4 = await repo.summarizeAccount("acct");
    expect(after4.consecutiveFails).toBe(1);
    expect(after4.lastFailureAt).toEqual(at(4));
  });

  it("scopes the count per accountIdHash so two accounts don't share a bucket", async () => {
    const repo = new InMemoryLoginAttemptsRepository();
    await repo.record({
      accountIdHash: "alice",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(1),
    });
    await repo.record({
      accountIdHash: "alice",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(2),
    });
    await repo.record({
      accountIdHash: "bob",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(3),
    });
    expect((await repo.summarizeAccount("alice")).consecutiveFails).toBe(2);
    expect((await repo.summarizeAccount("bob")).consecutiveFails).toBe(1);
  });

  it("deleteOlderThan drops rows strictly older than the cutoff and returns the row count", async () => {
    const repo = new InMemoryLoginAttemptsRepository();
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(1_000),
    });
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(2_000),
    });
    await repo.record({
      accountIdHash: "acct",
      ipHash: "ip",
      success: false,
      attemptedAt: new Date(3_000),
    });
    const dropped = await repo.deleteOlderThan(new Date(2_000));
    expect(dropped).toBe(1);
    expect((await repo.summarizeAccount("acct")).consecutiveFails).toBe(2);
  });
});
