import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE, messagesFor } from "../i18n/messages.ts";
import { _resetCartStoreForTest } from "../features/cart/store.ts";
import { _resetDatabaseSingletonForTest } from "../data/db/index.ts";
import { TenderQrisScreen } from "./tender.qris.tsx";

const locale = DEFAULT_LOCALE;
const messages = messagesFor(locale);

vi.mock("@tanstack/react-router", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

function renderScreen(props: Parameters<typeof TenderQrisScreen>[0] = {}) {
  return render(
    <IntlProvider locale={locale} messages={messages} defaultLocale="en">
      <TenderQrisScreen {...props} />
    </IntlProvider>,
  );
}

describe("TenderQrisScreen — auto mode toggle (KASA-197)", () => {
  beforeEach(() => {
    _resetCartStoreForTest();
  });
  afterEach(() => {
    _resetDatabaseSingletonForTest();
  });

  it("auto-renders the dynamic panel when navigator.onLine is true", () => {
    renderScreen({ isOffline: () => false });
    const root = screen.getByTestId("tender-qris-screen");
    expect(root.dataset.mode).toBe("dynamic");
    expect(root.dataset.modeSource).toBe("auto");
    // Dynamic panel root testid is `tender-qris`; static is `tender-qris-static`.
    expect(screen.getByTestId("tender-qris")).toBeTruthy();
    expect(screen.queryByTestId("tender-qris-static")).toBeNull();
  });

  it("auto-renders the static panel when navigator.onLine is false", () => {
    renderScreen({ isOffline: () => true });
    const root = screen.getByTestId("tender-qris-screen");
    expect(root.dataset.mode).toBe("static");
    expect(root.dataset.modeSource).toBe("auto");
    expect(screen.getByTestId("tender-qris-static")).toBeTruthy();
    expect(screen.queryByTestId("tender-qris")).toBeNull();
  });

  it("the manual toggle flips dynamic→static and overrides auto-detection", async () => {
    const user = userEvent.setup();
    renderScreen({ isOffline: () => false });
    const root = screen.getByTestId("tender-qris-screen");
    expect(root.dataset.mode).toBe("dynamic");

    await user.click(screen.getByTestId("tender-qris-mode-toggle"));
    await waitFor(() => expect(root.dataset.mode).toBe("static"));
    // The toggle made it sticky — `data-mode-source` switches to manual so
    // a later online/offline change does not silently flip the panel.
    expect(root.dataset.modeSource).toBe("manual");
    expect(screen.getByTestId("tender-qris-static")).toBeTruthy();
  });

  it("the manual toggle flips static→dynamic when the clerk overrides offline detection", async () => {
    const user = userEvent.setup();
    renderScreen({ isOffline: () => true });
    const root = screen.getByTestId("tender-qris-screen");
    expect(root.dataset.mode).toBe("static");

    await user.click(screen.getByTestId("tender-qris-mode-toggle"));
    await waitFor(() => expect(root.dataset.mode).toBe("dynamic"));
    expect(root.dataset.modeSource).toBe("manual");
    expect(screen.getByTestId("tender-qris")).toBeTruthy();
  });
});
