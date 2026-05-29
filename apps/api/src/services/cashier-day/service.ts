import type { CashierDayRepository } from "./repository.js";
import type { CashierDayInput, CashierDayResult } from "./types.js";

/*
 * Thin orchestrator over the cashier-day repository (KASA-368).
 *
 * No domain invariants today — the repository owns the GROUP BY, the route
 * owns RBAC and totals, and the service exists as a seam so a future caller
 * (e.g. a scheduled CSV mailer) can reuse the aggregation without taking a
 * Fastify dependency. Mirrors the `DashboardService` posture from KASA-237.
 */

export interface CashierDayServiceDeps {
  repository: CashierDayRepository;
}

export class CashierDayService {
  private readonly repository: CashierDayRepository;

  constructor(deps: CashierDayServiceDeps) {
    this.repository = deps.repository;
  }

  async getReport(input: CashierDayInput): Promise<CashierDayResult> {
    return this.repository.getCashierDay(input);
  }
}
