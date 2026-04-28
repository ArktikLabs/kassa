import { uuidv7 } from "../../lib/uuid.js";
import type { SalesRepository } from "../sales/index.js";
import type { EodSyntheticReconciler } from "./repository.js";

/*
 * KASA-151 — adapter that lets the EOD service reach into the sales
 * aggregate to write balancing `synthetic_eod_reconcile` ledger entries
 * for the KASA-71 production probe. The actual mirror logic lives in
 * `SalesRepository.reconcileSyntheticSales`; this class is the seam that
 * keeps `EodService` from depending on the sales port directly.
 */
export class SalesRepositoryEodSyntheticReconciler implements EodSyntheticReconciler {
  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly idGenerator: () => string = uuidv7,
  ) {}

  async reconcileSyntheticSales(input: {
    saleIds: readonly string[];
    occurredAt: string;
  }): Promise<void> {
    if (input.saleIds.length === 0) return;
    await this.salesRepository.reconcileSyntheticSales({
      saleIds: input.saleIds,
      occurredAt: input.occurredAt,
      idGenerator: this.idGenerator,
    });
  }
}
