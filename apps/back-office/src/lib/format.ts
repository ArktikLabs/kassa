/*
 * Formatting helpers shared by back-office tables and forms.
 *
 * - Rupiah uses the Indonesian locale grouping (`Rp 12.500`).
 * - Stable short IDs show the first 8 chars of a scaffold id so tables
 *   remain readable without leaking the full synthetic key.
 */

const RUPIAH = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function formatRupiah(value: number): string {
  return RUPIAH.format(value);
}

export function parseRupiahInput(input: string): number {
  const digits = input.replace(/[^0-9]/g, "");
  return digits.length === 0 ? 0 : Number.parseInt(digits, 10);
}

export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length) + "…";
}
