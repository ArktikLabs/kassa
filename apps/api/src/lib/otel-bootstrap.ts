import { initOtel } from "./otel.js";

/*
 * Side-effect entrypoint for OpenTelemetry. `apps/api/src/index.ts` imports
 * this module *before* `./app.js` so the trace SDK is registered before any
 * Fastify or instrumented module is evaluated. Keeping `initOtel` in a
 * separate file lets tests pull the helpers from `./otel.js` without
 * triggering the production boot side effect.
 */
initOtel();
