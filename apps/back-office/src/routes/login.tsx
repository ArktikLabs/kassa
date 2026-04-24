import { useState, type FormEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useRouter } from "@tanstack/react-router";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { getSnapshot } from "../data/store";
import { saveSession } from "../lib/session";

/*
 * Login route (ARCHITECTURE §4.1 auth contract).
 *
 * In the scaffold we match the email + password against the seeded
 * staff row and issue a local session. Wiring to `POST /v1/auth/
 * session/login` on `@kassa/api` is the next ticket — the form and
 * validation already follow that contract so the swap is a network
 * call change, not a UX one.
 */

// Scaffold password for the seeded owner. The real credential lives
// server-side (Argon2id-hashed) behind the auth endpoint.
const SCAFFOLD_PASSWORD = "welcome-to-kassa";

export function LoginScreen() {
  const router = useRouter();
  const intl = useIntl();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const staff = getSnapshot().staff.find(
      (s) => s.email.toLowerCase() === email.trim().toLowerCase() && s.isActive,
    );
    if (!staff || password !== SCAFFOLD_PASSWORD) {
      setError(intl.formatMessage({ id: "login.error" }));
      return;
    }
    saveSession({
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      issuedAt: new Date().toISOString(),
    });
    void router.navigate({ to: "/outlets" });
  };

  return (
    <main className="min-h-dvh bg-neutral-50 px-4 py-16">
      <div className="mx-auto max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-md">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="login.heading" />
        </h1>
        <p className="mt-2 text-sm text-neutral-600">
          <FormattedMessage id="login.subheading" />
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field
            label={<FormattedMessage id="login.email" />}
            htmlFor="login-email"
          >
            <TextInput
              id="login-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label={<FormattedMessage id="login.password" />}
            htmlFor="login-password"
            error={error}
          >
            <TextInput
              id="login-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full">
            <FormattedMessage id="login.submit" />
          </Button>
        </form>
      </div>
    </main>
  );
}
