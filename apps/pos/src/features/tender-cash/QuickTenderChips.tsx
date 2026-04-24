import { useIntl } from "react-intl";
import { formatIdr, toRupiah, type Rupiah } from "../../shared/money/index.ts";

export interface QuickTenderValue {
  kind: "exact" | "amount";
  amountIdr: Rupiah;
  labelId: string;
}

/*
 * DESIGN-SYSTEM §6.7 quick-tender chips. "Pas" stamps the running amount to
 * exactly cover the total; numeric chips set it to a common note.
 */
export const QUICK_TENDER_CHIPS: readonly QuickTenderValue[] = [
  { kind: "exact", amountIdr: toRupiah(0), labelId: "tender.cash.chip.pas" },
  { kind: "amount", amountIdr: toRupiah(50_000), labelId: "tender.cash.chip.50k" },
  { kind: "amount", amountIdr: toRupiah(100_000), labelId: "tender.cash.chip.100k" },
  { kind: "amount", amountIdr: toRupiah(200_000), labelId: "tender.cash.chip.200k" },
];

interface QuickTenderChipsProps {
  totalIdr: Rupiah;
  onPick(amount: Rupiah): void;
  disabled?: boolean;
}

export function QuickTenderChips({
  totalIdr,
  onPick,
  disabled,
}: QuickTenderChipsProps) {
  const intl = useIntl();
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "tender.cash.chips.aria" })}
      className="flex flex-wrap gap-2"
      data-testid="quick-tender-chips"
    >
      {QUICK_TENDER_CHIPS.map((chip) => {
        const label =
          chip.kind === "exact"
            ? intl.formatMessage({ id: chip.labelId })
            : formatIdr(chip.amountIdr);
        const amount = chip.kind === "exact" ? totalIdr : chip.amountIdr;
        return (
          <button
            key={chip.labelId}
            type="button"
            disabled={disabled}
            onClick={() => onPick(amount)}
            data-testid={`chip-${chip.labelId}`}
            className={[
              "h-11 rounded-full border border-neutral-300 bg-white px-4 text-sm font-semibold tabular-nums text-neutral-800",
              "active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
            data-tabular="true"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
