import type { DashboardSummary, DashboardSummaryInput } from "./types.js";

/*
 * Storage contract for the dashboard aggregator (KASA-237).
 *
 * One method, one round-trip: implementations are expected to do the heavy
 * aggregation at the database layer (SQL `SUM`/`COUNT` + `GROUP BY`), not by
 * shipping every sale row to the application. The in-memory variant exists
 * only for tests / scaffold deploys; production deploys bind the Pg variant.
 */
export interface DashboardRepository {
  getDashboardSummary(input: DashboardSummaryInput): Promise<DashboardSummary>;
}

/** Maximum rows returned in either top-items leaderboard. Matches the response cap on the wire. */
export const DASHBOARD_TOP_ITEMS_LIMIT = 5;
