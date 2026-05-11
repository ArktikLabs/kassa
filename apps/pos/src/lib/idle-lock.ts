/*
 * Idle auto-lock store and watcher (KASA-251).
 *
 * The POS tablet sits on the counter all day; anyone walking past can
 * ring a fake sale or void a real one. After `DEFAULT_IDLE_TIMEOUT_MS`
 * with no `pointerdown` / `keydown` and no return from a hidden tab we
 * lock the UI behind a PIN keypad. Three wrong attempts trigger a
 * `PIN_COOLDOWN_MS` lock-out.
 *
 * State is in-memory only — a full reload drops the lock (the
 * enrolment-based session is the gate at that point).
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
export const MAX_PIN_ATTEMPTS = 3;
export const PIN_COOLDOWN_MS = 30_000;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

// Plain-text PINs in localStorage are a v0 stopgap. KASA-221 (merchant
// settings) will source the cashier roster, and the manager flow will
// reuse the argon2 hash already on the staff table for void approvals.
const CASHIER_PIN_KEY = "kassa.pos.lockPin.cashier";
const MANAGER_PIN_KEY = "kassa.pos.lockPin.manager";
export const DEFAULT_CASHIER_PIN = "1234";
export const DEFAULT_MANAGER_PIN = "9999";

export type PinRole = "cashier" | "manager";

export type AttemptResult =
  | { kind: "ok"; role: PinRole }
  | { kind: "wrong"; attemptsRemaining: number }
  | { kind: "cooldown"; cooldownUntil: number };

export type LockState = {
  locked: boolean;
  attemptsRemaining: number;
  cooldownUntil: number | null;
};

const INITIAL_STATE: LockState = {
  locked: false,
  attemptsRemaining: MAX_PIN_ATTEMPTS,
  cooldownUntil: null,
};

export type PinVerifier = (pin: string) => PinRole | null;

export function isValidPinShape(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readStoredPin(key: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw && isValidPinShape(raw)) return raw;
  } catch {
    // private-mode / disabled storage: fall back to default
  }
  return fallback;
}

export function defaultPinVerifier(pin: string): PinRole | null {
  if (!isValidPinShape(pin)) return null;
  const cashier = readStoredPin(CASHIER_PIN_KEY, DEFAULT_CASHIER_PIN);
  const manager = readStoredPin(MANAGER_PIN_KEY, DEFAULT_MANAGER_PIN);
  if (constantTimeEquals(pin, cashier)) return "cashier";
  if (constantTimeEquals(pin, manager)) return "manager";
  return null;
}

export type IdleLockStore = {
  get(): LockState;
  subscribe(listener: () => void): () => void;
  lock(): void;
  attemptUnlock(pin: string): AttemptResult;
  clearCooldownIfElapsed(): boolean;
};

export interface CreateIdleLockStoreOptions {
  verifyPin?: PinVerifier;
  now?: () => number;
}

export function createIdleLockStore(opts: CreateIdleLockStoreOptions = {}): IdleLockStore {
  let state: LockState = { ...INITIAL_STATE };
  const listeners = new Set<() => void>();
  const verifyPin = opts.verifyPin ?? defaultPinVerifier;
  const now = opts.now ?? Date.now;

  function emit(): void {
    for (const l of listeners) l();
  }
  function setState(next: LockState): void {
    state = next;
    emit();
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lock() {
      if (state.locked) return;
      setState({ ...state, locked: true });
    },
    attemptUnlock(pin: string): AttemptResult {
      const t = now();
      if (state.cooldownUntil !== null && t < state.cooldownUntil) {
        return { kind: "cooldown", cooldownUntil: state.cooldownUntil };
      }
      // Cooldown has elapsed — refresh attempts before verifying.
      let attempts = state.attemptsRemaining;
      let cooldownUntil = state.cooldownUntil;
      if (cooldownUntil !== null && t >= cooldownUntil) {
        attempts = MAX_PIN_ATTEMPTS;
        cooldownUntil = null;
      }
      const role = verifyPin(pin);
      if (role) {
        setState({ locked: false, attemptsRemaining: MAX_PIN_ATTEMPTS, cooldownUntil: null });
        return { kind: "ok", role };
      }
      attempts -= 1;
      if (attempts <= 0) {
        const until = t + PIN_COOLDOWN_MS;
        setState({ locked: state.locked, attemptsRemaining: 0, cooldownUntil: until });
        return { kind: "cooldown", cooldownUntil: until };
      }
      setState({ locked: state.locked, attemptsRemaining: attempts, cooldownUntil: null });
      return { kind: "wrong", attemptsRemaining: attempts };
    },
    /**
     * Returns `true` when the cooldown had elapsed and was cleared so the
     * UI can refresh its attempts counter; `false` otherwise.
     */
    clearCooldownIfElapsed(): boolean {
      if (state.cooldownUntil === null) return false;
      if (now() < state.cooldownUntil) return false;
      setState({ ...state, attemptsRemaining: MAX_PIN_ATTEMPTS, cooldownUntil: null });
      return true;
    },
  };
}

type EventTargetLike = {
  addEventListener: (type: string, listener: (e: Event) => void, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (
    type: string,
    listener: (e: Event) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
};

export interface StartIdleWatcherOptions {
  store: IdleLockStore;
  timeoutMs?: number;
  /** Defaults to `window`. Override in tests with a mock event target. */
  target?: EventTargetLike;
  /** Defaults to `document`. Override in tests; pass `null` to skip visibility tracking. */
  document?: Document | null;
}

/**
 * Wires `pointerdown` / `keydown` (capture phase, on `window`) and
 * `visibilitychange` (on `document`) to the store. While the store is
 * locked the timer stays cleared — the watcher re-arms when the store
 * transitions back to unlocked. Returns a cleanup function.
 */
export function startIdleWatcher(opts: StartIdleWatcherOptions): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const target: EventTargetLike | null =
    opts.target ?? (typeof window !== "undefined" ? window : null);
  const doc =
    opts.document === undefined
      ? typeof document !== "undefined"
        ? document
        : null
      : opts.document;
  if (!target) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function arm(): void {
    clear();
    if (opts.store.get().locked) return;
    timer = setTimeout(() => {
      opts.store.lock();
    }, timeoutMs);
  }

  function onActivity(): void {
    if (opts.store.get().locked) return;
    arm();
  }
  function onVisibilityChange(): void {
    if (!doc) return;
    if (doc.visibilityState === "visible") onActivity();
  }

  target.addEventListener("pointerdown", onActivity, true);
  target.addEventListener("keydown", onActivity, true);
  if (doc) doc.addEventListener("visibilitychange", onVisibilityChange);

  // Re-arm when the store transitions out of `locked` (PIN accepted).
  const unsubscribe = opts.store.subscribe(() => {
    if (!opts.store.get().locked) arm();
    else clear();
  });

  arm();

  return () => {
    target.removeEventListener("pointerdown", onActivity, true);
    target.removeEventListener("keydown", onActivity, true);
    if (doc) doc.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribe();
    clear();
  };
}
