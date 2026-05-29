import type { CashierDayInput, CashierDayResult } from "./types.js";

/*
 * Storage contract for the per-cashier daily aggregator (KASA-368).
 *
 * One round-trip per request: production deploys push the GROUP BY into
 * Postgres rather than streaming sale rows into Node. The in-memory variant
 * exists for tests and scaffold deploys; production binds the Pg variant.
 */
export interface CashierDayRepository {
  getCashierDay(input: CashierDayInput): Promise<CashierDayResult>;
}
