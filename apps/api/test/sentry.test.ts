import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import {
  _deriveReleaseForTest as deriveRelease,
  _scrubStringForTest as scrub,
  initSentry,
} from "../src/lib/sentry.js";

describe("initSentry", () => {
  // Snapshot every Sentry-relevant env var so a stray value from the host
  // shell or a sibling test cannot make the no-op assertion pass for the
  // wrong reason. The afterEach restores them whether the test passed or
  // threw.
  const SNAPSHOT_KEYS = ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "KASSA_API_VERSION"] as const;
  const snapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    snapshot.clear();
    for (const key of SNAPSHOT_KEYS) {
      snapshot.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SNAPSHOT_KEYS) {
      const prev = snapshot.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  // `Sentry.getClient()` returns undefined when no client has been
  // initialised on the current scope. The test asserts initSentry() leaves
  // that state unchanged when the DSN is absent — `vi.spyOn(Sentry, "init")`
  // is unusable here because the SDK exports `init` as a non-configurable
  // ESM binding.
  it("is a no-op when SENTRY_DSN is unset", () => {
    expect(Sentry.getClient()).toBeUndefined();
    initSentry();
    expect(Sentry.getClient()).toBeUndefined();
  });

  it("is a no-op when SENTRY_DSN is the empty string (Fly secret unset)", () => {
    // Fly secrets surface as the empty string when a secret is declared but
    // not given a value; treat that the same as unset so a half-configured
    // app does not start emitting to a default-project DSN.
    process.env.SENTRY_DSN = "";
    initSentry();
    expect(Sentry.getClient()).toBeUndefined();
  });

  it("is a no-op when SENTRY_DSN is whitespace only", () => {
    process.env.SENTRY_DSN = "   ";
    initSentry();
    expect(Sentry.getClient()).toBeUndefined();
  });
});

describe("deriveRelease", () => {
  it("returns undefined when KASSA_API_VERSION is unset", () => {
    expect(deriveRelease(undefined)).toBeUndefined();
    expect(deriveRelease("")).toBeUndefined();
    expect(deriveRelease("   ")).toBeUndefined();
  });

  it.each([
    ["prod-0123456789ab", "kassa-api@0123456789ab"],
    ["staging-abcdef012345", "kassa-api@abcdef012345"],
    ["preview-pr-42-deadbeefcafe", "kassa-api@deadbeefcafe"],
  ])("strips tier prefix from %s → %s", (input, expected) => {
    expect(deriveRelease(input)).toBe(expected);
  });

  it("falls back to the raw version when the trailing 12-hex pattern does not match", () => {
    // Defensive: a future deploy path that tags with a non-sha label still
    // tags events under a deterministic release name rather than dropping
    // the release tag silently.
    expect(deriveRelease("custom-tag")).toBe("kassa-api@custom-tag");
  });
});

describe("sentry scrubString (mirrors apps/pos)", () => {
  it("masks Indonesian phone numbers", () => {
    expect(scrub("Call 0812-3456-7890 now")).toBe("Call [phone] now");
    expect(scrub("+62 812 3456 7890")).toBe("[phone]");
  });

  it("masks emails", () => {
    expect(scrub("contact admin@example.com today")).toBe("contact [email] today");
  });

  it("masks Indonesian street addresses", () => {
    expect(scrub("Jl. Sudirman No. 25")).toBe("[address]");
    expect(scrub("Jl. Kebon Jeruk No. 5 RT 03 RW 04")).toBe("[address] [address] [address]");
  });

  it("masks 12+ digit runs (card / bank-account shaped)", () => {
    expect(scrub("acct 4111111111111111 was charged")).toBe("acct [digits] was charged");
  });

  it("does not mask short digit runs or version-like dotted numerics", () => {
    expect(scrub("order 12345 fulfilled")).toBe("order 12345 fulfilled");
    expect(scrub("v1.0.2 released")).toBe("v1.0.2 released");
    expect(scrub("Build 0.500.100.123 failed")).toBe("Build 0.500.100.123 failed");
  });

  it("does not mask 'no one' or 'rt happy' as addresses", () => {
    expect(scrub("There is no one here")).toBe("There is no one here");
    expect(scrub("rt happy path")).toBe("rt happy path");
  });
});
