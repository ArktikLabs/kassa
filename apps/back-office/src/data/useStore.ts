import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "./store";

/*
 * Resource accessors wrap the shared snapshot so each table/form
 * renders only the slice it needs and re-renders only when that slice
 * changes identity. When we swap the in-memory store for TanStack
 * Query these hooks turn into a thin query wrapper with the same
 * signature so the call sites do not change.
 */

export function useOutlets() {
  return useSyncExternalStore(subscribe, () => getSnapshot().outlets);
}

export function useCatalogItems() {
  return useSyncExternalStore(subscribe, () => getSnapshot().items);
}

export function useBoms() {
  return useSyncExternalStore(subscribe, () => getSnapshot().boms);
}

export function useStaff() {
  return useSyncExternalStore(subscribe, () => getSnapshot().staff);
}

export function useEnrolmentCodes() {
  return useSyncExternalStore(subscribe, () => getSnapshot().enrolmentCodes);
}

export function useDevices() {
  return useSyncExternalStore(subscribe, () => getSnapshot().devices);
}

export function useReconciliation() {
  return useSyncExternalStore(subscribe, () => getSnapshot().reconciliation);
}

export function useUnmatchedStaticTenders() {
  return useSyncExternalStore(subscribe, () => getSnapshot().unmatchedStaticTenders);
}

export function useMerchantSettings() {
  return useSyncExternalStore(subscribe, () => getSnapshot().merchant);
}
