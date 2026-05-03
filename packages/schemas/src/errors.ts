import { z } from "zod";

/*
 * Wire schemas for the shared API error envelope.
 *
 * Every route under `apps/api/src/routes/` returns this shape on a
 * non-2xx response (`apps/api/src/lib/errors.ts` is the server-side
 * helper that builds it). The PWA and back-office consume the same
 * envelope when they branch on `error.code`, so the contract belongs
 * here in `@kassa/schemas` rather than in `apps/api`.
 *
 * KASA-179 — schema-drift contract gate.
 */

export const errorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string().describe("Machine-readable error code, snake_case."),
        message: z.string().describe("Human-readable error message."),
        details: z.unknown().optional().describe("Optional structured detail payload."),
      })
      .strict(),
  })
  .strict()
  .describe("Standard Kassa API error envelope.");

export type ErrorBody = z.infer<typeof errorBodySchema>;

/**
 * Standard 501 response used by every placeholder endpoint. Routes that
 * are reserved-but-not-implemented spread this into their `response` map.
 */
export const notImplementedResponses = {
  501: errorBodySchema.describe("Endpoint is reserved but not yet implemented."),
} as const;
