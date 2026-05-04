import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { buildApp } from "../src/app.js";
import { beforeSend, _shouldDropBodyForTest as shouldDropBody } from "../src/lib/sentry.js";

/*
 * Integration coverage for the Sentry wiring (KASA-196):
 *
 *  - Boots a Fastify app with a stub route that throws under `app.inject`.
 *  - Captures the event via a custom transport instead of the network so
 *    the assertions run offline and deterministic (vitest workers have no
 *    network policy guarantee in CI).
 *  - Asserts the transport saw exactly one event for the request, that the
 *    PII in the thrown error was masked by `beforeSend`, and that the
 *    isolation scope tags from `applyDeviceTags` landed on the event.
 *
 * Sentry state is global per-process. vitest runs each test file in its own
 * worker (the default `fileParallelism` plus `pool: "threads"`), so the
 * `Sentry.init` here cannot leak into `sentry.test.ts`. We still tear the
 * client down in `afterAll` so a follow-up describe block in this file
 * starts from a clean slate.
 */

interface CapturedEvent {
  type: "event";
  event: ErrorEvent;
}

type TransportFactory = NonNullable<Parameters<typeof Sentry.init>[0]>["transport"];

function makeCapturingTransport(): {
  capture: () => CapturedEvent[];
  factory: NonNullable<TransportFactory>;
} {
  const captured: CapturedEvent[] = [];
  const factory: NonNullable<TransportFactory> = () => ({
    async send(envelope) {
      const items = envelope[1] as ReadonlyArray<readonly [{ type: string }, unknown]>;
      for (const [header, payload] of items) {
        if (header.type === "event") {
          captured.push({ type: "event", event: payload as ErrorEvent });
        }
      }
      return { statusCode: 200 };
    },
    async flush() {
      return true;
    },
  });
  return { capture: () => captured, factory };
}

const TEST_DSN = "https://kasa196@o0.ingest.sentry.invalid/0";

describe("sentry — apps/api integration (KASA-196)", () => {
  const transport = makeCapturingTransport();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    Sentry.init({
      dsn: TEST_DSN,
      environment: "test",
      release: "kassa-api@test00000000",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend,
      transport: transport.factory,
    });

    let counter = 0;
    app = await buildApp({
      onCreate(instance) {
        // Stub route that throws an Error containing PII so the scrubber
        // has something to mask. Registered via `onCreate` so it lands
        // before `setupFastifyErrorHandler`, mirroring how production
        // routes are wired. The counter suffix in the error message keeps
        // each throw unique so Sentry's default `dedupeIntegration` does
        // not collapse repeat invocations.
        instance.post("/__sentry_test/throw_with_pii", async (req) => {
          counter += 1;
          // Tag the request with a synthetic device principal — the same
          // shape the device-auth preHandler installs in production —
          // so the `applyDeviceTags` hook in app.ts can exercise its full
          // path. We do not run device-auth in this test (no credentials
          // to sign), but the principal is just a request decoration once
          // populated.
          req.devicePrincipal = {
            deviceId: "device-test-0001",
            merchantId: "merchant-test-0001",
            outletId: "outlet-test-0001",
          };
          throw new Error(`crash #${counter} on email admin@example.com phone 0812-3456-7890`);
        });
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Sentry.close(2000);
  });

  it("captures exactly one event for a 500 and masks PII in the error message", async () => {
    const before = transport.capture().length;

    const res = await app.inject({
      method: "POST",
      url: "/__sentry_test/throw_with_pii",
      payload: { note: "irrelevant" },
    });
    expect(res.statusCode).toBe(500);

    // `Sentry.flush` waits for the transport queue to drain; the boolean
    // it returns is whether everything flushed within the timeout. Failing
    // here means an event leaked past the test's deadline, which would
    // make the count assertion racy.
    const flushed = await Sentry.flush(2000);
    expect(flushed).toBe(true);

    const events = transport.capture().slice(before);
    expect(events).toHaveLength(1);
    const event = events[0]?.event;
    if (!event) throw new Error("expected captured event");
    const value = event.exception?.values?.[0]?.value ?? "";
    expect(value).not.toContain("admin@example.com");
    expect(value).not.toContain("0812-3456-7890");
    expect(value).toContain("[email]");
    expect(value).toContain("[phone]");
  });

  it("tags the event with merchant_id / outlet_id / device_id from device-auth", async () => {
    const before = transport.capture().length;

    const res = await app.inject({
      method: "POST",
      url: "/__sentry_test/throw_with_pii",
      payload: {},
    });
    expect(res.statusCode).toBe(500);

    const flushed = await Sentry.flush(2000);
    expect(flushed).toBe(true);

    const events = transport.capture().slice(before);
    expect(events).toHaveLength(1);
    const event = events[0]?.event;
    if (!event) throw new Error("expected captured event");
    expect(event.tags?.merchant_id).toBe("merchant-test-0001");
    expect(event.tags?.outlet_id).toBe("outlet-test-0001");
    expect(event.tags?.device_id).toBe("device-test-0001");
  });
});

describe("sentry — beforeSend route-based body strip (KASA-196)", () => {
  // Pure-function coverage for the path allowlist; runs without `Sentry.init`
  // so the assertions are deterministic regardless of any sibling test that
  // may have left a global client around.

  it("drops request.data on POST /v1/sales", () => {
    const event = beforeSend({
      request: {
        method: "POST",
        url: "/v1/sales",
        data: { buyerName: "Budi" },
      },
    } as ErrorEvent);
    expect(event.request?.data).toBeUndefined();
  });

  it("drops request.data on POST /v1/payments/qris", () => {
    const event = beforeSend({
      request: {
        method: "POST",
        url: "/v1/payments/qris",
        data: { localSaleId: "abc", buyerPhone: "+62 812 3456 7890" },
      },
    } as ErrorEvent);
    expect(event.request?.data).toBeUndefined();
  });

  it("drops request.data on POST /v1/auth/session/login", () => {
    const event = beforeSend({
      request: {
        method: "POST",
        url: "/v1/auth/session/login",
        data: { email: "admin@example.com", pin: "1234" },
      },
    } as ErrorEvent);
    expect(event.request?.data).toBeUndefined();
  });

  it("drops request.query_string on PII routes", () => {
    const event = beforeSend({
      request: {
        method: "POST",
        url: "/v1/sales/01ABC/refund",
        query_string: "buyer=admin@example.com",
        data: { reason: "wrong order" },
      },
    } as ErrorEvent);
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
  });

  it("keeps request.data on safe routes (regex-scrubbed only)", () => {
    const event = beforeSend({
      request: {
        method: "POST",
        url: "/v1/auth/enroll",
        data: { fingerprint: "fp-123", note: "phone 0812-3456-7890" },
      },
    } as ErrorEvent);
    // Body is preserved; the regex masker still runs on string fields.
    expect(event.request?.data).toBeDefined();
    expect(JSON.stringify(event.request?.data)).toContain("[phone]");
    expect(JSON.stringify(event.request?.data)).not.toContain("0812-3456-7890");
  });

  it("treats sub-paths of `/v1/sales` as PII (e.g. /v1/sales/<id>/void)", () => {
    expect(shouldDropBody("POST", "/v1/sales/01ABC/void")).toBe(true);
  });

  it("does not drop body on `/v1/salesperson` (prefix boundary)", () => {
    expect(shouldDropBody("POST", "/v1/salesperson")).toBe(false);
  });

  it("does not drop body on GET requests to PII paths (only POST handles bodies)", () => {
    expect(shouldDropBody("GET", "/v1/sales")).toBe(false);
  });

  it("handles full URLs (Fastify integration sometimes captures host + path)", () => {
    expect(shouldDropBody("POST", "https://api.kassa.id/v1/payments/qris?retry=1")).toBe(true);
  });
});

// `applyDeviceTags` no-op-without-client behaviour is exercised in
// test/sentry.test.ts where Sentry has not been initialised in the file.
// We do not re-cover it here because the integration block above leaves a
// real client on the global scope and `Sentry.close()` does not reset
// `getClient()`, so a precondition check would always fail.
