export { SalesService, SalesError } from "./service.js";
export type {
  SalesServiceDeps,
  SubmitSaleOutcome,
  SubmitSaleOk,
  SubmitSaleConflict,
} from "./service.js";
export { InMemorySalesRepository } from "./memory-repository.js";
export type { SalesRepository, LedgerAppendInput } from "./repository.js";
export type {
  Bom,
  BomComponent,
  Item,
  Outlet,
  Sale,
  SaleLine,
  SaleTender,
  StockLedgerEntry,
  SubmitSaleInput,
  SubmitSaleResult,
} from "./types.js";
