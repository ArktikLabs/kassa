import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { ChargeButton } from "./ChargeButton.tsx";
import { toRupiah, zeroRupiah } from "../../../shared/money/index.ts";
import { messagesFor } from "../../../i18n/messages.ts";

function renderButton(ui: React.ReactElement) {
  return render(
    <IntlProvider locale="id-ID" messages={messagesFor("id-ID")}>
      {ui}
    </IntlProvider>,
  );
}

describe("<ChargeButton />", () => {
  it("shows the empty-state label and is disabled when cart is empty", () => {
    const onClick = vi.fn();
    renderButton(
      <ChargeButton totalIdr={zeroRupiah} disabled onClick={onClick} />,
    );
    const button = screen.getByRole("button", { name: /tambah barang dulu/i });
    expect(button).toBeDisabled();
  });

  it("shows `Bayar Rp <total>` and calls onClick when cart has items", async () => {
    const onClick = vi.fn();
    renderButton(
      <ChargeButton
        totalIdr={toRupiah(47500)}
        disabled={false}
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toMatch(/Bayar/);
    expect(button.textContent).toMatch(/47\.500/);
    const user = userEvent.setup();
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
