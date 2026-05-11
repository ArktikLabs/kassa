import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createIdleLockStore,
  DEFAULT_IDLE_TIMEOUT_MS,
  startIdleWatcher,
  type IdleLockStore,
  type LockState,
} from "./idle-lock.ts";
import { LockOverlay } from "../components/LockOverlay.tsx";

const IdleLockContext = createContext<IdleLockStore | null>(null);

const INITIAL_LOCK_STATE: LockState = {
  locked: false,
  attemptsRemaining: 0,
  cooldownUntil: null,
};

export interface IdleLockProviderProps {
  children: ReactNode;
  /** Disable the watcher (e.g. on the unenrolled `/enrol` route). */
  enabled?: boolean;
  /** Override in tests; defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Tests inject a pre-built store so they can drive it directly. */
  store?: IdleLockStore;
}

export function IdleLockProvider({
  children,
  enabled = true,
  timeoutMs,
  store: injectedStore,
}: IdleLockProviderProps) {
  const ownStoreRef = useRef<IdleLockStore | null>(null);
  if (!injectedStore && !ownStoreRef.current) {
    ownStoreRef.current = createIdleLockStore();
  }
  const store = injectedStore ?? ownStoreRef.current!;

  useEffect(() => {
    if (!enabled) return;
    return startIdleWatcher({ store, timeoutMs: timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS });
  }, [store, enabled, timeoutMs]);

  const locked = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get().locked,
    () => INITIAL_LOCK_STATE.locked,
  );

  return (
    <IdleLockContext.Provider value={store}>
      <div
        data-testid="idle-lock-content"
        aria-hidden={locked || undefined}
        aria-disabled={locked || undefined}
        inert={locked || undefined}
        className="contents"
      >
        {children}
      </div>
      {locked ? <LockOverlay store={store} /> : null}
    </IdleLockContext.Provider>
  );
}

export function useIdleLockStore(): IdleLockStore {
  const ctx = useContext(IdleLockContext);
  if (!ctx) {
    throw new Error("useIdleLockStore must be used inside IdleLockProvider");
  }
  return ctx;
}
