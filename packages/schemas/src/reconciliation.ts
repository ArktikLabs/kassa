import { z } from "zod";

/*
 * Wire schemas for the static-QRIS reconciliation admin endpoints
 * (KASA-117). Two operations:
 *
 *   - POST /v1/admin/reconciliation/run    — owner triggers the EOD pass
 *     ad-hoc (BullMQ schedule lands separately under KASA-111). Returns the
 *     `ReconcilePassReport` so the back-office page can show counts.
 *
 *   - POST /v1/admin/reconciliation/match  — owner manually flips a stuck
 *     unverified static-QRIS tender to verified after eyeballing the
 *     Midtrans dashboard or the buyer's transfer screenshot. The note is
 *     mandatory so the audit trail isn't blank.
 *
 * `businessDate` follows the same `YYYY-MM-DD` shape used by `eodCloseRequest`.
 * `outletId` and `tenderId` are UUIDv7 — the same id flavour the rest of the
 * data plane uses.
 */

const uuidV7 = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const reconciliationRunRequest = z
  .object({
    outletId: uuidV7,
    businessDate,
  })
  .strict();
export type ReconciliationRunRequest = z.infer<typeof reconciliationRunRequest>;

export const reconciliationMatchEntry = z
  .object({
    tenderId: uuidV7,
    providerTransactionId: z.string().min(1),
    settledAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ReconciliationMatchEntry = z.infer<typeof reconciliationMatchEntry>;

export const reconciliationRunResponse = z
  .object({
    outletId: uuidV7,
    businessDate,
    matchedCount: z.number().int().nonnegative(),
    consideredTenderCount: z.number().int().nonnegative(),
    settlementRowCount: z.number().int().nonnegative(),
    matches: z.array(reconciliationMatchEntry),
    unmatchedTenderIds: z.array(uuidV7),
    unmatchedSettlementIds: z.array(z.string().min(1)),
  })
  .strict();
export type ReconciliationRunResponse = z.infer<typeof reconciliationRunResponse>;

export const reconciliationManualMatchRequest = z
  .object({
    tenderId: uuidV7,
    /**
     * The Midtrans `transaction_id` the operator pegged this tender to, or
     * `null` when no provider row is on hand (rare — real-money escape hatch
     * for buyer-screenshot evidence). Stored alongside the note for audit.
     */
    providerTransactionId: z.string().min(1).nullable(),
    /**
     * Required free-text justification — surfaces as the audit row on the
     * tender. Keep loose enough for Bahasa Indonesia operator notes; cap at
     * 500 chars to mirror `eodCloseRequest.varianceReason`.
     */
    note: z.string().min(1).max(500),
  })
  .strict();
export type ReconciliationManualMatchRequest = z.infer<typeof reconciliationManualMatchRequest>;

export const reconciliationManualMatchResponse = z
  .object({
    tenderId: uuidV7,
    /**
     * `flipped` — the tender was unverified and is now verified. `noop` —
     * the tender was already verified (idempotent retry from the back-office
     * page). The route returns 404 instead of `not_found` here so this enum
     * stays a positive-outcome shape.
     */
    outcome: z.enum(["flipped", "noop"]),
  })
  .strict();
export type ReconciliationManualMatchResponse = z.infer<typeof reconciliationManualMatchResponse>;
