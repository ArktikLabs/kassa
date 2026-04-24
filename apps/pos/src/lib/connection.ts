import { useEffect, useState } from "react";
import type { ConnectionState } from "../components/ConnectionPill";

export type UseConnectionStateOptions = {
  healthUrl?: string;
  intervalMs?: number;
  fetchTimeoutMs?: number;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

function initialState(): ConnectionState {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  return "online";
}

/*
 * Drives the connection-state pill (DESIGN-SYSTEM §6.9) for the M2
 * shell. `navigator.onLine` resolves the offline branch instantly;
 * a cheap `GET /health` every 30 s tells the difference between
 * "online" (probe ok) and "error" (network claims online but the
 * backend is unreachable / 5xx). The `syncing` state ships with the
 * sync engine in a follow-up — this hook only emits the three states
 * needed by the M2 shell.
 */
export function useConnectionState(
  options: UseConnectionStateOptions = {},
): ConnectionState {
  const healthUrl =
    options.healthUrl ?? import.meta.env.VITE_HEALTH_URL ?? "/health";
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const [state, setState] = useState<ConnectionState>(initialState);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (!cancelled) setState("offline");
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        const res = await fetch(healthUrl, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        setState(res.ok ? "online" : "error");
      } catch {
        if (cancelled) return;
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          setState("offline");
        } else {
          setState("error");
        }
      } finally {
        clearTimeout(timer);
      }
    }

    function onOnline() {
      void probe();
    }
    function onOffline() {
      if (!cancelled) setState("offline");
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void probe();
    const id = window.setInterval(probe, intervalMs);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(id);
    };
  }, [healthUrl, intervalMs, fetchTimeoutMs]);

  return state;
}
