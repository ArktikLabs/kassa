import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "../src/i18n/IntlProvider";
import { UpdatePrompt } from "../src/components/UpdatePrompt";
import {
  _resetPwaStoreForTest,
  dismissOfflineReady,
  markOfflineReady,
  markUpdateAvailable,
} from "../src/lib/pwaStore";

afterEach(() => {
  _resetPwaStoreForTest();
});

function renderPrompt() {
  return render(
    <IntlProvider locale="id-ID">
      <UpdatePrompt />
    </IntlProvider>,
  );
}

describe("UpdatePrompt + pwaStore", () => {
  it("renders nothing while no PWA event has fired", () => {
    renderPrompt();
    expect(screen.queryByTestId("pwa-update-toast")).toBeNull();
    expect(screen.queryByTestId("pwa-offline-ready-toast")).toBeNull();
  });

  it("shows the update toast when markUpdateAvailable fires and triggers the accept handler on click", async () => {
    const accept = vi.fn();
    renderPrompt();
    act(() => markUpdateAvailable(accept));
    const toast = await screen.findByTestId("pwa-update-toast");
    expect(toast).toHaveTextContent("Update tersedia — muat ulang");
    const button = screen.getByRole("button", { name: "Muat ulang" });
    act(() => button.click());
    expect(accept).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("pwa-update-toast")).toBeNull();
  });

  it("shows the offline-ready toast and dismisses on click without invoking the update handler", async () => {
    renderPrompt();
    act(() => markOfflineReady());
    const toast = await screen.findByTestId("pwa-offline-ready-toast");
    expect(toast).toHaveTextContent("Siap untuk dipakai offline");
    act(() => dismissOfflineReady());
    expect(screen.queryByTestId("pwa-offline-ready-toast")).toBeNull();
  });
});
