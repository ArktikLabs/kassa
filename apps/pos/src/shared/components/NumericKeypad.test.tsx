import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { NumericKeypad, applyKeypadKey } from "./NumericKeypad.tsx";
import { messagesFor } from "../../i18n/messages.ts";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <IntlProvider locale="id-ID" messages={messagesFor("id-ID")}>
      {ui}
    </IntlProvider>,
  );
}

describe("applyKeypadKey", () => {
  it("appends digits", () => {
    expect(applyKeypadKey(0, "5")).toBe(5);
    expect(applyKeypadKey(5, "0")).toBe(50);
    expect(applyKeypadKey(12, "3")).toBe(123);
  });

  it("appends `00`", () => {
    expect(applyKeypadKey(1, "00")).toBe(100);
    expect(applyKeypadKey(0, "00")).toBe(0);
  });

  it("backspaces the last digit", () => {
    expect(applyKeypadKey(123, "backspace")).toBe(12);
    expect(applyKeypadKey(5, "backspace")).toBe(0);
    expect(applyKeypadKey(0, "backspace")).toBe(0);
  });
});

describe("<NumericKeypad />", () => {
  it("renders 12 keys with an accessible label", () => {
    const onKey = vi.fn();
    renderWithIntl(<NumericKeypad onKey={onKey} />);
    const group = screen.getByRole("group", { name: /keypad/i });
    expect(group).toBeInTheDocument();
    expect(group.querySelectorAll("button")).toHaveLength(12);
  });

  it("forwards key presses via onKey", async () => {
    const onKey = vi.fn();
    renderWithIntl(<NumericKeypad onKey={onKey} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "7" }));
    await user.click(screen.getByRole("button", { name: "00" }));
    await user.click(screen.getByRole("button", { name: /hapus digit/i }));
    expect(onKey).toHaveBeenNthCalledWith(1, "7");
    expect(onKey).toHaveBeenNthCalledWith(2, "00");
    expect(onKey).toHaveBeenNthCalledWith(3, "backspace");
  });
});
