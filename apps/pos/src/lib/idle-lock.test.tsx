/*
 * KASA-251 — idle auto-lock unit tests.
 *
 * Drives the store directly for the timing-sensitive cases (cooldown,
 * attempts) and renders the provider for the integration check that
 * proves underlying content keeps its React state across a lock/unlock
 * cycle (the "cart preserved" acceptance criterion).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { messagesFor, DEFAULT_LOCALE, FALLBACK_LOCALE } from "../i18n/messages";
import {
  createIdleLockStore,
  DEFAULT_CASHIER_PIN,
  DEFAULT_MANAGER_PIN,
  defaultPinVerifier,
  isValidPinShape,
  MAX_PIN_ATTEMPTS,
  PIN_COOLDOWN_MS,
  startIdleWatcher,
  type IdleLockStore,
} from "./idle-lock";
import { IdleLockProvider } from "./idle-lock-provider";

function withIntl(node: React.ReactNode) {
  return (
    <IntlProvider
      locale={DEFAULT_LOCALE}
      defaultLocale={FALLBACK_LOCALE}
      messages={messagesFor(DEFAULT_LOCALE)}
    >
      {node}
    </IntlProvider>
  );
}

describe("idle-lock store", () => {
  let now = 1_700_000_000_000;
  const nowFn = () => now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    localStorage.clear();
  });

  it("unlocks on the correct cashier PIN", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();
    expect(store.get().locked).toBe(true);
    const r = store.attemptUnlock(DEFAULT_CASHIER_PIN);
    expect(r).toEqual({ kind: "ok", role: "cashier" });
    expect(store.get()).toEqual({
      locked: false,
      attemptsRemaining: MAX_PIN_ATTEMPTS,
      cooldownUntil: null,
    });
  });

  it("unlocks on the manager PIN too", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();
    const r = store.attemptUnlock(DEFAULT_MANAGER_PIN);
    expect(r).toEqual({ kind: "ok", role: "manager" });
    expect(store.get().locked).toBe(false);
  });

  it("counts attempts down on wrong PIN and triggers cooldown after 3", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();

    const r1 = store.attemptUnlock("0000");
    expect(r1).toEqual({ kind: "wrong", attemptsRemaining: 2 });
    expect(store.get().attemptsRemaining).toBe(2);

    const r2 = store.attemptUnlock("0000");
    expect(r2).toEqual({ kind: "wrong", attemptsRemaining: 1 });

    const r3 = store.attemptUnlock("0000");
    expect(r3.kind).toBe("cooldown");
    if (r3.kind === "cooldown") {
      expect(r3.cooldownUntil).toBe(now + PIN_COOLDOWN_MS);
    }
    expect(store.get().attemptsRemaining).toBe(0);
    expect(store.get().cooldownUntil).toBe(now + PIN_COOLDOWN_MS);
  });

  it("rejects further attempts during cooldown without consuming them", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");
    const cooldownUntil = store.get().cooldownUntil;
    expect(cooldownUntil).not.toBeNull();

    // Even the correct PIN is rejected while cooldown is active.
    const r = store.attemptUnlock(DEFAULT_CASHIER_PIN);
    expect(r).toEqual({ kind: "cooldown", cooldownUntil });
    expect(store.get().locked).toBe(true);
  });

  it("refreshes attempts when cooldown elapses and accepts the next correct PIN", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");
    expect(store.get().cooldownUntil).toBe(now + PIN_COOLDOWN_MS);

    now += PIN_COOLDOWN_MS;
    const r = store.attemptUnlock(DEFAULT_CASHIER_PIN);
    expect(r).toEqual({ kind: "ok", role: "cashier" });
    expect(store.get()).toEqual({
      locked: false,
      attemptsRemaining: MAX_PIN_ATTEMPTS,
      cooldownUntil: null,
    });
  });

  it("clearCooldownIfElapsed refreshes attempts once the timestamp passes", () => {
    const store = createIdleLockStore({ now: nowFn });
    store.lock();
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");
    store.attemptUnlock("0000");

    expect(store.clearCooldownIfElapsed()).toBe(false);
    now += PIN_COOLDOWN_MS;
    expect(store.clearCooldownIfElapsed()).toBe(true);
    expect(store.get().cooldownUntil).toBeNull();
    expect(store.get().attemptsRemaining).toBe(MAX_PIN_ATTEMPTS);
  });

  it("emits to subscribers on lock and unlock", () => {
    const store = createIdleLockStore({ now: nowFn });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.lock();
    expect(listener).toHaveBeenCalledTimes(1);
    store.attemptUnlock(DEFAULT_CASHIER_PIN);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("defaultPinVerifier", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("accepts the default cashier PIN when no override is stored", () => {
    expect(defaultPinVerifier(DEFAULT_CASHIER_PIN)).toBe("cashier");
    expect(defaultPinVerifier(DEFAULT_MANAGER_PIN)).toBe("manager");
  });

  it("respects an override stored in localStorage", () => {
    localStorage.setItem("kassa.pos.lockPin.cashier", "246810");
    expect(defaultPinVerifier("246810")).toBe("cashier");
    expect(defaultPinVerifier(DEFAULT_CASHIER_PIN)).toBe(null);
  });

  it("rejects malformed PINs", () => {
    expect(defaultPinVerifier("abc1")).toBe(null);
    expect(defaultPinVerifier("123")).toBe(null); // too short
    expect(defaultPinVerifier("12345678")).toBe(null); // too long
    expect(isValidPinShape("123456")).toBe(true);
  });
});

describe("startIdleWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTarget() {
    const listeners: Record<string, Array<(e: Event) => void>> = {};
    return {
      target: {
        addEventListener(type: string, listener: (e: Event) => void) {
          (listeners[type] ??= []).push(listener);
        },
        removeEventListener(type: string, listener: (e: Event) => void) {
          listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
        },
      },
      fire(type: string) {
        for (const l of listeners[type] ?? []) l(new Event(type));
      },
    };
  }

  it("locks after the configured timeout with no activity", () => {
    const store = createIdleLockStore();
    const { target } = makeTarget();
    const stop = startIdleWatcher({ store, target, document: null, timeoutMs: 1000 });
    expect(store.get().locked).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(store.get().locked).toBe(true);
    stop();
  });

  it("pointerdown resets the timer", () => {
    const store = createIdleLockStore();
    const { target, fire } = makeTarget();
    const stop = startIdleWatcher({ store, target, document: null, timeoutMs: 1000 });
    vi.advanceTimersByTime(800);
    fire("pointerdown");
    vi.advanceTimersByTime(800);
    expect(store.get().locked).toBe(false);
    vi.advanceTimersByTime(300);
    expect(store.get().locked).toBe(true);
    stop();
  });

  it("keydown resets the timer", () => {
    const store = createIdleLockStore();
    const { target, fire } = makeTarget();
    const stop = startIdleWatcher({ store, target, document: null, timeoutMs: 1000 });
    vi.advanceTimersByTime(800);
    fire("keydown");
    vi.advanceTimersByTime(800);
    expect(store.get().locked).toBe(false);
    stop();
  });

  it("visibilitychange to visible resets the timer", () => {
    const store = createIdleLockStore();
    const { target } = makeTarget();
    const visibilityListeners: Array<() => void> = [];
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener(_: string, l: () => void) {
        visibilityListeners.push(l);
      },
      removeEventListener(_: string, l: () => void) {
        const i = visibilityListeners.indexOf(l);
        if (i >= 0) visibilityListeners.splice(i, 1);
      },
    } as unknown as Document;
    const stop = startIdleWatcher({ store, target, document: doc, timeoutMs: 1000 });
    vi.advanceTimersByTime(800);
    for (const l of visibilityListeners) l();
    vi.advanceTimersByTime(800);
    expect(store.get().locked).toBe(false);
    vi.advanceTimersByTime(300);
    expect(store.get().locked).toBe(true);
    stop();
  });

  it("re-arms after the PIN is accepted", () => {
    const store = createIdleLockStore();
    const { target } = makeTarget();
    const stop = startIdleWatcher({ store, target, document: null, timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(store.get().locked).toBe(true);
    store.attemptUnlock(DEFAULT_CASHIER_PIN);
    expect(store.get().locked).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(store.get().locked).toBe(true);
    stop();
  });

  it("cleanup removes listeners and clears the timer", () => {
    const store = createIdleLockStore();
    const { target, fire } = makeTarget();
    const stop = startIdleWatcher({ store, target, document: null, timeoutMs: 1000 });
    stop();
    vi.advanceTimersByTime(2000);
    expect(store.get().locked).toBe(false);
    fire("pointerdown"); // should be a no-op after cleanup
    expect(store.get().locked).toBe(false);
  });
});

describe("IdleLockProvider integration", () => {
  function ChildWithState() {
    const [count, setCount] = useState(0);
    return (
      <div>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          increment
        </button>
        <span data-testid="counter">{count}</span>
      </div>
    );
  }

  let storeRef: IdleLockStore | null = null;
  beforeEach(() => {
    storeRef = createIdleLockStore();
    localStorage.clear();
  });

  it("renders content normally when unlocked, with no overlay", () => {
    render(
      withIntl(
        <IdleLockProvider enabled={false} store={storeRef!}>
          <ChildWithState />
        </IdleLockProvider>,
      ),
    );
    expect(screen.queryByTestId("lock-overlay")).toBeNull();
    const content = screen.getByTestId("idle-lock-content");
    expect(content).not.toHaveAttribute("aria-disabled");
  });

  it("shows the overlay and disables the underlying tree when locked", () => {
    render(
      withIntl(
        <IdleLockProvider enabled={false} store={storeRef!}>
          <ChildWithState />
        </IdleLockProvider>,
      ),
    );
    act(() => storeRef!.lock());
    expect(screen.getByTestId("lock-overlay")).toBeInTheDocument();
    const content = screen.getByTestId("idle-lock-content");
    expect(content).toHaveAttribute("aria-disabled", "true");
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(content).toHaveAttribute("inert");
  });

  it("preserves child React state across a lock + unlock cycle", () => {
    render(
      withIntl(
        <IdleLockProvider enabled={false} store={storeRef!}>
          <ChildWithState />
        </IdleLockProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /increment/i }));
    fireEvent.click(screen.getByRole("button", { name: /increment/i }));
    expect(screen.getByTestId("counter")).toHaveTextContent("2");

    act(() => storeRef!.lock());
    expect(screen.getByTestId("lock-overlay")).toBeInTheDocument();

    // Enter the default cashier PIN via the in-overlay keypad.
    for (const d of DEFAULT_CASHIER_PIN.split("")) {
      fireEvent.click(screen.getByTestId(`lock-key-${d}`));
    }
    fireEvent.click(screen.getByTestId("lock-submit"));

    expect(screen.queryByTestId("lock-overlay")).toBeNull();
    expect(screen.getByTestId("counter")).toHaveTextContent("2");
  });

  it("shows the cooldown banner after three wrong PINs", () => {
    render(
      withIntl(
        <IdleLockProvider enabled={false} store={storeRef!}>
          <ChildWithState />
        </IdleLockProvider>,
      ),
    );
    act(() => storeRef!.lock());

    function enter(pin: string) {
      for (const d of pin.split("")) {
        fireEvent.click(screen.getByTestId(`lock-key-${d}`));
      }
      fireEvent.click(screen.getByTestId("lock-submit"));
    }

    enter("0000");
    enter("0000");
    enter("0000");

    expect(screen.getByTestId("lock-cooldown")).toBeInTheDocument();
    const submit = screen.getByTestId("lock-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();
  });
});
