import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  MAX_PIN_ATTEMPTS,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  type IdleLockStore,
} from "../lib/idle-lock.ts";

/*
 * Lock screen for KASA-251. Fullscreen modal that covers the active
 * route, with a PIN keypad sized for thumb input on the counter tablet.
 * The keypad lives inline (not the shared `NumericKeypad`) because PIN
 * digits enter one-at-a-time — there's no "00" key — and the cooldown
 * countdown lives where the submit button does.
 */

const KEYPAD_KEYS: readonly string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  // Empty cell keeps the 3×4 grid balanced — 0 is centre, backspace on the right.
  "",
  "0",
  "backspace",
];

export interface LockOverlayProps {
  store: IdleLockStore;
}

export function LockOverlay({ store }: LockOverlayProps) {
  const state = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
    () => store.get(),
  );
  const intl = useIntl();
  const [pin, setPin] = useState("");
  const [errorKey, setErrorKey] = useState<"wrong" | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Tick the cooldown countdown; when it reaches zero, ask the store to
  // refresh the attempts counter (one tick after the timestamp passes).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (state.cooldownUntil === null) return;
    const id = window.setInterval(() => {
      const cleared = store.clearCooldownIfElapsed();
      forceTick((n) => n + 1);
      if (cleared) {
        setErrorKey(null);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [state.cooldownUntil, store]);

  // Move focus into the dialog so the cashier can start typing on a
  // keyboard-attached tablet without an extra tap.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const now = Date.now();
  const inCooldown = state.cooldownUntil !== null && now < state.cooldownUntil;
  const cooldownSecondsRemaining = inCooldown
    ? Math.max(1, Math.ceil(((state.cooldownUntil ?? now) - now) / 1000))
    : 0;

  function handleKey(key: string): void {
    if (inCooldown) return;
    if (key === "backspace") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (!/^\d$/.test(key)) return;
    setErrorKey(null);
    setPin((p) => (p.length < PIN_MAX_LENGTH ? p + key : p));
  }

  function handleSubmit(): void {
    if (inCooldown) return;
    if (pin.length < PIN_MIN_LENGTH) return;
    const r = store.attemptUnlock(pin);
    if (r.kind === "ok") {
      setPin("");
      setErrorKey(null);
      return;
    }
    setPin("");
    if (r.kind === "wrong") {
      setErrorKey("wrong");
    } else {
      setErrorKey(null);
    }
  }

  // Allow pressing Enter on a hardware keyboard to submit.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmit();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      handleKey("backspace");
    } else if (/^\d$/.test(event.key)) {
      event.preventDefault();
      handleKey(event.key);
    }
  }

  const submitDisabled = inCooldown || pin.length < PIN_MIN_LENGTH;

  return (
    <div
      data-testid="lock-overlay"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900/80 px-4 py-6 backdrop-blur-sm"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: "lock.title" })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-[min(28rem,100%)] space-y-4 rounded-lg bg-white p-6 shadow-xl focus:outline-none"
      >
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-neutral-900">
            <FormattedMessage id="lock.title" />
          </h2>
          <p className="text-sm text-neutral-600">
            <FormattedMessage id="lock.subtitle" />
          </p>
        </header>

        <PinDisplay value={pin} max={PIN_MAX_LENGTH} />

        <div className="min-h-[1.5rem] text-sm" aria-live="polite">
          {inCooldown ? (
            <p data-testid="lock-cooldown" className="font-semibold text-neutral-700">
              <FormattedMessage
                id="lock.cooldown"
                values={{ seconds: cooldownSecondsRemaining }}
              />
            </p>
          ) : errorKey === "wrong" ? (
            <p data-testid="lock-error" role="alert" className="font-semibold text-error-fg">
              <FormattedMessage
                id="lock.error.wrong"
                values={{ remaining: Math.max(0, state.attemptsRemaining) }}
              />
            </p>
          ) : (
            <p className="text-neutral-500">
              <FormattedMessage
                id="lock.attemptsRemaining"
                values={{
                  remaining: state.attemptsRemaining,
                  max: MAX_PIN_ATTEMPTS,
                }}
              />
            </p>
          )}
        </div>

        <div
          role="group"
          aria-label={intl.formatMessage({ id: "lock.keypad.aria" })}
          data-testid="lock-keypad"
          className="grid grid-cols-3 gap-2"
        >
          {KEYPAD_KEYS.map((key, i) =>
            key === "" ? (
              <span key={`empty-${i}`} aria-hidden="true" />
            ) : (
              <button
                key={key}
                type="button"
                disabled={inCooldown}
                onClick={() => handleKey(key)}
                data-testid={`lock-key-${key}`}
                aria-label={
                  key === "backspace"
                    ? intl.formatMessage({ id: "lock.key.backspace" })
                    : key
                }
                className={[
                  "h-16 rounded-md border border-neutral-200 bg-white text-2xl font-bold tabular-nums text-neutral-800",
                  "active:bg-neutral-100 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                ].join(" ")}
              >
                {key === "backspace" ? "⌫" : key}
              </button>
            ),
          )}
        </div>

        <button
          type="button"
          data-testid="lock-submit"
          onClick={handleSubmit}
          disabled={submitDisabled}
          className="w-full rounded-md bg-primary-600 px-4 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FormattedMessage id="lock.submit" />
        </button>
      </div>
    </div>
  );
}

function PinDisplay({ value, max }: { value: string; max: number }) {
  const filled = value.length;
  const dots = Array.from({ length: max }, (_, i) => i < filled);
  return (
    <div
      data-testid="lock-pin-display"
      data-pin-length={filled}
      aria-label="PIN"
      className="flex justify-center gap-2"
    >
      {dots.map((isFilled, i) => (
        <span
          key={i}
          className={
            isFilled
              ? "h-3 w-3 rounded-full bg-primary-700"
              : "h-3 w-3 rounded-full border border-neutral-300"
          }
        />
      ))}
    </div>
  );
}
