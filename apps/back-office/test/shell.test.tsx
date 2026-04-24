import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { LoginScreen } from "../src/routes/login";
import { Forbidden } from "../src/components/Forbidden";
import { renderAt } from "./harness";
import { _scrubStringForTest } from "../src/lib/sentry";

describe("Back-office shell", () => {
  it("renders the login screen with id-ID copy and the email/password fields", async () => {
    renderAt("/login", [{ path: "/login", component: LoginScreen }]);
    expect(await screen.findByRole("heading", { name: "Masuk Back Office" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Kata sandi")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Masuk" })).toBeInTheDocument();
  });

  it("renders the forbidden state for non-manager roles", async () => {
    renderAt("/forbidden", [{ path: "/forbidden", component: Forbidden }]);
    expect(await screen.findByRole("heading", { name: "Akses dibatasi" })).toBeInTheDocument();
  });

  it("scrubs PII (phone, email, address, long digit runs) before sending to Sentry", () => {
    const dirty = "Owner 0812-3456-7890 at Jl. Sudirman No.1 (acct 1234567890123) email a@b.co";
    const cleaned = _scrubStringForTest(dirty);
    expect(cleaned).not.toMatch(/0812/);
    expect(cleaned).not.toMatch(/Sudirman/);
    expect(cleaned).not.toMatch(/1234567890123/);
    expect(cleaned).not.toMatch(/a@b\.co/);
    expect(cleaned).toContain("[phone]");
    expect(cleaned).toContain("[address]");
    expect(cleaned).toContain("[digits]");
    expect(cleaned).toContain("[email]");
  });
});
