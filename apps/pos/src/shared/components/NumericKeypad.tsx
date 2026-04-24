import { useIntl } from "react-intl";

export type KeypadKey =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "00"
  | "backspace";

/*
 * Appends the next digit(s) to a number, or deletes the last digit on backspace.
 * Callers (cart, tender) own the max-digits policy and any min/max clamping.
 */
export function applyKeypadKey(current: number, key: KeypadKey): number {
  if (key === "backspace") {
    return Math.floor(current / 10);
  }
  const digits = key === "00" ? "00" : key;
  const next = Number(`${current}${digits}`);
  return Number.isFinite(next) ? next : current;
}

interface NumericKeypadProps {
  onKey(key: KeypadKey): void;
  disabled?: boolean;
  "aria-label"?: string;
}

const KEYS: readonly KeypadKey[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "00",
  "0",
  "backspace",
];

export function NumericKeypad({ onKey, disabled, "aria-label": ariaLabel }: NumericKeypadProps) {
  const intl = useIntl();
  const label = ariaLabel ?? intl.formatMessage({ id: "keypad.aria" });
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-3 gap-2"
      data-testid="numeric-keypad"
    >
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onKey(key)}
          data-testid={`keypad-${key}`}
          aria-label={key === "backspace" ? intl.formatMessage({ id: "keypad.backspace" }) : key}
          className={[
            "h-16 rounded-md border border-neutral-200 bg-white text-2xl font-bold tabular-nums text-neutral-800",
            "active:bg-neutral-100 active:scale-[0.97] transition-transform duration-[var(--animate-duration-instant)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          {key === "backspace" ? "⌫" : key}
        </button>
      ))}
    </div>
  );
}
