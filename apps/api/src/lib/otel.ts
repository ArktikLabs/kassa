import { SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/*
 * OpenTelemetry trace plumbing for the API tier (KASA-284). Two hot paths
 * carry named spans today: `sale.submit` and `eod.close`. Sub-spans inside
 * `sale.submit` slice the handler so a long tail at validation / idempotency
 * lookup / BOM explosion / ledger write is visible from a trace view.
 *
 * Boot semantics:
 *  - `OTEL_EXPORTER_OTLP_ENDPOINT` unset (the dev / CI default) → `initOtel`
 *    returns `{ started: false }` and no global tracer provider is
 *    registered. `trace.getTracer(...)` then returns the OTEL API's NoOp
 *    tracer, so `withSpan` runs `fn` straight through with effectively zero
 *    overhead and the API does NOT crash on boot. Mirrors the KASA-203
 *    pattern for SESSION_COOKIE_SECRET — degrade quietly rather than fail
 *    closed (ADR-011).
 *  - `OTEL_EXPORTER_OTLP_ENDPOINT` set → a `NodeSDK` is instantiated with an
 *    OTLP/HTTP trace exporter. The exporter reads its own endpoint env var
 *    (and the optional `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` override) so the
 *    standard OTEL ergonomics work without extra wiring.
 *
 * Test seam:
 *  - Tests bypass `initOtel` and register their own provider before importing
 *    the service under test, see `apps/api/test/otel-spans.test.ts`.
 *  - `getTracer()` reads the API tracer lazily on every call, so a
 *    test-installed provider supersedes whatever (if anything) the boot
 *    sequence registered.
 */

const TRACER_NAME = "kassa-api";

let sdk: NodeSDK | null = null;

/**
 * Initialise the trace SDK against `OTEL_EXPORTER_OTLP_ENDPOINT`. Returns
 * whether an exporter was actually wired so the caller can log a structured
 * startup warning when telemetry is degraded.
 */
export function initOtel(): { started: boolean } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return { started: false };
  if (sdk) return { started: true };

  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "kassa-api";
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [],
  });
  sdk.start();
  return { started: true };
}

/**
 * Flush and stop the SDK. Called from the API's SIGINT/SIGTERM handler so
 * in-flight spans are exported before the process exits.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const handle = sdk;
  sdk = null;
  await handle.shutdown();
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export type SpanAttrValue = string | number | boolean;

/**
 * Run `fn` inside an active span. Attributes with `undefined` values are
 * skipped so callers can pass optional fields without a conditional spread.
 * On throw, the span is stamped `status=ERROR` with the thrown message and
 * an exception event before the error re-propagates — the goal is that a
 * failed sale is still legible in the trace view, not silently absent.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, SpanAttrValue | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return await fn(span);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}
