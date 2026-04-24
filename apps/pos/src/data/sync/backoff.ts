/*
 * Exponential backoff with full jitter for the read-through sync engine.
 *
 * ARCHITECTURE §3.1 Flow A calls for "network back-off" on 5xx and
 * offline errors; this helper is the single place we compute the delay
 * so the test suite can hold time steady and the runner doesn't grow
 * its own ad-hoc math.
 */

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_CAP_MS = 60_000;

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  if (attempt < 1) return 0;
  const base = options.baseMs ?? DEFAULT_BASE_MS;
  const cap = options.capMs ?? DEFAULT_CAP_MS;
  const rand = options.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(rand() * exp);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
