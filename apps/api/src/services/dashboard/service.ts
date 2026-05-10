import type { DashboardRepository } from "./repository.js";
import type { DashboardSummary, DashboardSummaryInput } from "./types.js";

/*
 * Thin orchestrator over the dashboard repository (KASA-237).
 *
 * The service exists to enforce one invariant the route doesn't: `from <= to`.
 * Every other concern — merchant scoping, role gating, response shaping —
 * lives in the route handler so the schema-driven OpenAPI export stays the
 * source of truth. Aggregation lives in the repository.
 */

export type DashboardErrorCode = "invalid_date_range";

export class DashboardError extends Error {
  constructor(
    readonly code: DashboardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DashboardError";
  }
}

export interface DashboardServiceDeps {
  repository: DashboardRepository;
}

export class DashboardService {
  private readonly repository: DashboardRepository;

  constructor(deps: DashboardServiceDeps) {
    this.repository = deps.repository;
  }

  async getSummary(input: DashboardSummaryInput): Promise<DashboardSummary> {
    if (input.from > input.to) {
      throw new DashboardError(
        "invalid_date_range",
        `from (${input.from}) must be <= to (${input.to})`,
      );
    }
    return this.repository.getDashboardSummary(input);
  }
}
