import { useState, type FormEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useRouter } from "@tanstack/react-router";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { sessionLogin, SessionLoginError } from "../data/api/session";
import { saveSession } from "../lib/session";

/*
 * Login route. Calls `POST /v1/auth/session/login` (ARCHITECTURE §4.1).
 * The session is held server-side in an HTTP-only cookie; the response
 * body returns the staff identity we render in the shell. KASA-182.
 */

export function LoginScreen() {
  const router = useRouter();
  const intl = useIntl();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const session = await sessionLogin({ email: email.trim(), password });
      saveSession({
        email: session.email,
        displayName: session.displayName,
        role: session.role,
        issuedAt: session.issuedAt,
      });
      void router.navigate({ to: "/outlets" });
    } catch (err) {
      const messageId = errorMessageId(err);
      setError(intl.formatMessage({ id: messageId }));
    } finally {
      setSubmitting(false);
    }
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
          <Field label={<FormattedMessage id="login.email" />} htmlFor="login-email">
            <TextInput
              id="login-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
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
              disabled={submitting}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={submitting}>
            <FormattedMessage id={submitting ? "login.submitting" : "login.submit"} />
          </Button>
        </form>
        {/*
         * Onboarding runbook discovery (KASA-69 acceptance criterion).
         * `/onboarding.md` is the printable runbook copied from
         * `docs/ONBOARDING.md` into `public/` at build time, so a brand-new
         * merchant who lands on the login screen on day one can read the
         * guide before they have credentials.
         */}
        <p className="mt-6 border-t border-neutral-200 pt-4 text-center text-sm text-neutral-600">
          <a
            href="/onboarding.md"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary-700 hover:underline"
          >
            <FormattedMessage id="login.onboarding.link" />
          </a>{" "}
          <FormattedMessage id="login.onboarding.suffix" />
        </p>
      </div>
    </main>
  );
}

function errorMessageId(err: unknown): string {
  if (err instanceof SessionLoginError) {
    switch (err.code) {
      case "invalid_credentials":
        return "login.error.invalidCredentials";
      case "rate_limited":
        return "login.error.rateLimited";
      case "not_implemented":
        return "login.error.notImplemented";
      case "not_configured":
        return "login.error.notConfigured";
      case "network_error":
        return "login.error.network";
      default:
        return "login.error.unknown";
    }
  }
  return "login.error.unknown";
}
