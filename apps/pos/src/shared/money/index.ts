declare const rupiahBrand: unique symbol;

export type Rupiah = number & { readonly [rupiahBrand]: true };

export class InvalidRupiahError extends Error {
  constructor(value: unknown, reason: string) {
    super(`Invalid Rupiah value ${String(value)}: ${reason}`);
    this.name = "InvalidRupiahError";
  }
}

const MAX_SAFE_RUPIAH = Number.MAX_SAFE_INTEGER;

function assertSafeInteger(value: number, source: string): void {
  if (!Number.isFinite(value)) throw new InvalidRupiahError(value, `${source} is not finite`);
  if (!Number.isInteger(value))
    throw new InvalidRupiahError(value, `${source} has a fractional part`);
  if (value < 0) throw new InvalidRupiahError(value, `${source} is negative`);
  if (value > MAX_SAFE_RUPIAH)
    throw new InvalidRupiahError(value, `${source} exceeds MAX_SAFE_INTEGER`);
}

export function toRupiah(value: number): Rupiah {
  assertSafeInteger(value, "number");
  return value as Rupiah;
}

export function fromNumber(value: number): Rupiah {
  const rounded = Math.round(value);
  assertSafeInteger(rounded, "rounded number");
  return rounded as Rupiah;
}

export function addRupiah(a: Rupiah, b: Rupiah): Rupiah {
  return toRupiah((a as number) + (b as number));
}

export function subtractRupiah(a: Rupiah, b: Rupiah): Rupiah {
  return toRupiah((a as number) - (b as number));
}

export function multiplyRupiah(amount: Rupiah, factor: number): Rupiah {
  return fromNumber((amount as number) * factor);
}

export const zeroRupiah: Rupiah = 0 as Rupiah;

const idrFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function formatIdr(value: Rupiah): string {
  return idrFormatter.format(value as number);
}

export function isRupiah(value: unknown): value is Rupiah {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_RUPIAH
  );
}
