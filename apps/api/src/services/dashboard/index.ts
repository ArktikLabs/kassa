export {
  DashboardService,
  DashboardError,
  type DashboardErrorCode,
  type DashboardServiceDeps,
} from "./service.js";
export type {
  DashboardItemRow,
  DashboardSummary,
  DashboardSummaryInput,
  DashboardTenderSlice,
} from "./types.js";
export { DASHBOARD_TOP_ITEMS_LIMIT, type DashboardRepository } from "./repository.js";
export {
  InMemoryDashboardRepository,
  type SeededItem,
  type SeededSale,
} from "./memory-repository.js";
export { PgDashboardRepository } from "./pg-repository.js";
