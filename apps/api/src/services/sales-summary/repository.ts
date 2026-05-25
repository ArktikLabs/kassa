import type { SalesSummary, SalesSummaryInput } from "./types.js";

/*
 * Storage contract for the period-summary aggregator (KASA-327).
 *
 * Implementations are expected to do the heavy aggregation at the database
 * layer (SQL `SUM`/`COUNT` + `GROUP BY`), not by shipping every sale row
 * to the application. The in-memory variant exists for tests and scaffold
 * deploys; production deploys bind the Pg variant.
 */
export interface SalesSummaryRepository {
  getSalesSummary(input: SalesSummaryInput): Promise<SalesSummary>;
}
