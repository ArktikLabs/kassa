export {
  SalesSummaryService,
  SalesSummaryError,
  type SalesSummaryErrorCode,
  type SalesSummaryServiceDeps,
} from "./service.js";
export type {
  SalesSummary,
  SalesSummaryGroupBy,
  SalesSummaryGroupRow,
  SalesSummaryInput,
  SalesSummaryItemRow,
  SalesSummaryTenderSlice,
} from "./types.js";
export type { SalesSummaryRepository } from "./repository.js";
export {
  InMemorySalesSummaryRepository,
  type SeededItem,
  type SeededOutlet,
  type SeededSale,
} from "./memory-repository.js";
