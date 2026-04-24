/*
 * Minimal toast surface for the M2 shell. A module-level emitter (`showToast`)
 * lets non-React modules trigger toasts (e.g. after router navigation); the
 * viewport lives in `RootLayout` and subscribes for renders.
 *
 * One toast at a time is enough for v0. Swap for a richer library if stacking
 * or severity filtering becomes a real requirement.
 */
import { useEffect, useState } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastEntry {
  id: number;
  tone: ToastTone;
  message: string;
}

type Listener = (entry: ToastEntry | null) => void;

const listeners = new Set<Listener>();
let current: ToastEntry | null = null;
let nextId = 1;
let dismissHandle: ReturnType<typeof setTimeout> | null = null;

function publish(entry: ToastEntry | null): void {
  current = entry;
  for (const l of listeners) l(current);
}

export function showToast(message: string, tone: ToastTone = "info", ttlMs = 4000): void {
  if (dismissHandle) {
    clearTimeout(dismissHandle);
    dismissHandle = null;
  }
  const entry: ToastEntry = { id: nextId++, tone, message };
  publish(entry);
  if (ttlMs > 0) {
    dismissHandle = setTimeout(() => {
      publish(null);
      dismissHandle = null;
    }, ttlMs);
  }
}

export function dismissToast(): void {
  if (dismissHandle) {
    clearTimeout(dismissHandle);
    dismissHandle = null;
  }
  publish(null);
}

export function ToastViewport() {
  const [toast, setToast] = useState<ToastEntry | null>(current);

  useEffect(() => {
    const listener: Listener = (entry) => setToast(entry);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (!toast) return null;

  const toneClass =
    toast.tone === "success"
      ? "bg-primary-700 text-white"
      : toast.tone === "error"
        ? "bg-red-700 text-white"
        : "bg-neutral-800 text-white";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div
        className={`pointer-events-auto max-w-xl rounded-md px-4 py-3 text-sm font-semibold shadow-lg ${toneClass}`}
      >
        {toast.message}
      </div>
    </div>
  );
}
