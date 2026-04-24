import { useIntl } from "react-intl";
import { formatIdr } from "../../../shared/money/index.ts";
import type { Rupiah } from "../../../shared/money/index.ts";

interface ChargeButtonProps {
  totalIdr: Rupiah;
  disabled: boolean;
  onClick(): void;
}

export function ChargeButton({ totalIdr, disabled, onClick }: ChargeButtonProps) {
  const intl = useIntl();
  const label = disabled
    ? intl.formatMessage({ id: "cart.charge.empty" })
    : intl.formatMessage({ id: "cart.charge.pay" }, { total: formatIdr(totalIdr) });
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid="charge-button"
      aria-label={label}
      className={[
        "w-full h-14 rounded-md text-base font-semibold tabular-nums",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
        disabled
          ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
          : "bg-primary-600 text-white active:bg-primary-700",
      ].join(" ")}
      data-tabular="true"
    >
      {label}
    </button>
  );
}
