import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import {
  EnrolApiError,
  enrolDevice,
  getSnapshot,
  subscribe,
  type EnrolmentSnapshot,
} from "../lib/enrolment";
import { isBarcodeDetectorSupported, QrScanner } from "../components/QrScanner";
import { showToast } from "../components/Toast";

const CODE_ALPHABET_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const BOOT_STATE: EnrolmentSnapshot = { state: "loading" };

type ErrorKey =
  | "enrol.error.code_not_found"
  | "enrol.error.code_expired"
  | "enrol.error.code_already_used"
  | "enrol.error.bad_request"
  | "enrol.error.rate_limited"
  | "enrol.error.network_error"
  | "enrol.error.unknown"
  | "enrol.error.code_format";

function messageKeyForError(err: unknown): ErrorKey {
  if (err instanceof EnrolApiError) {
    switch (err.code) {
      case "code_not_found":
        return "enrol.error.code_not_found";
      case "code_expired":
        return "enrol.error.code_expired";
      case "code_already_used":
        return "enrol.error.code_already_used";
      case "bad_request":
        return "enrol.error.bad_request";
      case "rate_limited":
        return "enrol.error.rate_limited";
      case "network_error":
        return "enrol.error.network_error";
      default:
        return "enrol.error.unknown";
    }
  }
  return "enrol.error.unknown";
}

function useEnrolmentSnapshot(): EnrolmentSnapshot {
  const [snap, setSnap] = useState<EnrolmentSnapshot>(() => getSnapshot() ?? BOOT_STATE);
  useEffect(() => subscribe(setSnap), []);
  return snap;
}

export function EnrolScreen() {
  const intl = useIntl();
  const navigate = useNavigate();
  const snapshot = useEnrolmentSnapshot();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const scannerSupported = useMemo(() => isBarcodeDetectorSupported(), []);

  // The router's beforeLoad already redirects enrolled devices away from
  // /enrol on navigation, but we also handle in-place transitions (the
  // success path below and the reset flow from /admin).
  useEffect(() => {
    if (snapshot.state === "enrolled") {
      void navigate({ to: "/catalog", replace: true });
    }
  }, [snapshot.state, navigate]);

  const canSubmit = !submitting && CODE_ALPHABET_RE.test(code);

  async function submit(raw: string): Promise<void> {
    const normalised = raw.trim().toUpperCase();
    if (!CODE_ALPHABET_RE.test(normalised)) {
      setErrorKey("enrol.error.code_format");
      setCode(normalised);
      return;
    }
    setSubmitting(true);
    setErrorKey(null);
    try {
      const device = await enrolDevice(normalised);
      showToast(
        intl.formatMessage(
          { id: "enrol.toast.success" },
          { outlet: device.outlet.name },
        ),
        "success",
      );
      await navigate({ to: "/catalog", replace: true });
    } catch (err) {
      setErrorKey(messageKeyForError(err));
      // Leave the input populated so the clerk can correct it; refocus for
      // quick retry.
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit(code);
  }

  function handleScanned(value: string): void {
    setScannerOpen(false);
    // Enrolment QRs encode just the 8-char code. Strip whitespace/newlines
    // (common in test QRs) and hand off to submit — unknown inputs still
    // flow through the server's 404 path.
    void submit(value);
  }

  return (
    <section className="mx-auto max-w-xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="enrol.heading" />
        </h1>
        <p className="text-neutral-600">
          <FormattedMessage id="enrol.intro" />
        </p>
      </header>

      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <label className="block space-y-2" htmlFor="enrol-code">
          <span className="text-sm font-semibold text-neutral-800">
            <FormattedMessage id="enrol.code.label" />
          </span>
          <input
            ref={inputRef}
            id="enrol-code"
            name="enrol-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={8}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\s+/g, "").toUpperCase());
              if (errorKey) setErrorKey(null);
            }}
            aria-invalid={errorKey !== null}
            aria-describedby={errorKey ? "enrol-error" : undefined}
            placeholder={intl.formatMessage({ id: "enrol.code.placeholder" })}
            className="h-14 w-full rounded-md border border-neutral-300 bg-white px-4 font-mono text-2xl uppercase tracking-[0.3em] text-neutral-900 outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-600/30"
          />
          <span className="block text-xs text-neutral-500">
            <FormattedMessage id="enrol.code.hint" />
          </span>
        </label>

        {errorKey ? (
          <div
            id="enrol-error"
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            <p className="font-semibold">
              <FormattedMessage id={errorKey} />
            </p>
            <button
              type="button"
              onClick={() => {
                setErrorKey(null);
                inputRef.current?.focus();
              }}
              className="mt-2 text-sm font-semibold text-red-700 underline"
            >
              <FormattedMessage id="enrol.error.retry" />
            </button>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="h-14 w-full rounded-md bg-primary-600 font-semibold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
        >
          <FormattedMessage id={submitting ? "enrol.cta.submitting" : "enrol.cta"} />
        </button>

        {scannerSupported ? (
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="h-12 w-full rounded-md border border-primary-600 bg-white font-semibold text-primary-700 hover:bg-primary-50"
          >
            <FormattedMessage id="enrol.cta.scan" />
          </button>
        ) : (
          <p className="text-center text-xs text-neutral-500">
            <FormattedMessage id="enrol.cta.scan_unsupported" />
          </p>
        )}
      </form>

      {scannerOpen ? (
        <QrScanner onDetected={handleScanned} onClose={() => setScannerOpen(false)} />
      ) : null}
    </section>
  );
}
