import { uuidv7 } from "../../lib/uuidv7.ts";
import { getDatabase } from "../../data/db/index.ts";
import type { PendingVoid } from "../../data/db/types.ts";

/*
 * High-level orchestration for the manager-PIN sale void (KASA-236-B).
 *
 * `enqueueVoid` is the only public mutation: it stamps a `pending_voids`
 * outbox row AND flips the `pending_sales` row's `voidedAt` optimistically
 * so the PEMBATALAN banner appears on the receipt preview even before the
 * server confirms. The sync runner's `pushVoids` drain owns the network
 * half; on a terminal 4xx (e.g. 403 manager-PIN, 422 outside-open-shift)
 * the row lands in `needs_attention` and the UI surfaces the error.
 */

export interface VoidSaleDraft {
  /** Server sale id — the path parameter of POST /v1/sales/:saleId/void. */
  saleId: string;
  /** Local sale id — used to flip the local `pending_sales` row. */
  localSaleId: string;
  outletId: string;
  managerStaffId: string;
  managerPin: string;
  voidBusinessDate: string;
  reason?: string | null;
  /** Override clock for tests; defaults to `new Date()`. */
  now?: () => Date;
}

export interface EnqueueVoidResult {
  row: PendingVoid;
}

export async function enqueueVoid(input: VoidSaleDraft): Promise<EnqueueVoidResult> {
  const database = await getDatabase();
  const now = input.now ?? (() => new Date());
  const stamp = now();
  const occurredAt = stamp.toISOString();
  const localVoidId = uuidv7(stamp.getTime());

  const reason = input.reason && input.reason.trim().length > 0 ? input.reason.trim() : null;

  const row = await database.repos.pendingVoids.enqueue({
    localVoidId,
    saleId: input.saleId,
    localSaleId: input.localSaleId,
    outletId: input.outletId,
    managerStaffId: input.managerStaffId,
    managerPin: input.managerPin,
    voidedAt: occurredAt,
    voidBusinessDate: input.voidBusinessDate,
    reason,
    createdAt: occurredAt,
  });

  // Flip the local sale optimistically — PEMBATALAN banner shows offline.
  // The drain's `onVoidSynced` hook re-stamps these fields once the
  // server confirms; the values match by construction so the second write
  // is a no-op semantically.
  await database.repos.pendingSales.markVoided(input.localSaleId, {
    voidedAt: occurredAt,
    voidBusinessDate: input.voidBusinessDate,
    voidReason: reason,
    voidLocalId: localVoidId,
  });

  return { row };
}
