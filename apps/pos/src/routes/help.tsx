import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";

/*
 * In-PWA mirror of `docs/ONBOARDING.md` (KASA-69 acceptance criterion).
 *
 * The runbook lives in two surfaces:
 *
 *   1. `docs/ONBOARDING.md` is the printable, paginated source of truth for
 *      pilot merchants. Linked from the back-office login screen.
 *   2. This `/help` route renders the same flow on-device with deep links
 *      into the screens (`/enrol`, `/admin`, `/eod`, `/catalog`) so a clerk
 *      mid-onboarding can jump straight into the right step instead of
 *      flipping back to a printed sheet.
 *
 * Copy is intentionally inline here rather than fetched from `onboarding.md`
 * because (a) the PWA must work offline (so the runbook must be in the
 * precache), and (b) deep links need to be real `<Link>` components that
 * play nicely with TanStack Router's prefetch / nav guard, not bare anchors
 * inside rendered markdown.
 *
 * When you change the runbook, update both this component AND
 * `docs/ONBOARDING.md` in the same PR. The intl strings are keyed `help.*`.
 */

export function HelpRoute() {
  const intl = useIntl();
  const targetMinutes = 15;
  const updatedOn = intl.formatDate("2026-04-26", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <article className="mx-auto max-w-2xl space-y-8 pb-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="help.heading" />
        </h1>
        <p className="text-neutral-600">
          <FormattedMessage
            id="help.intro"
            values={{ minutes: targetMinutes, strong: (chunks) => <strong>{chunks}</strong> }}
          />
        </p>
        <p className="text-sm text-neutral-500">
          <FormattedMessage id="help.updated" values={{ date: updatedOn }} />
        </p>
      </header>

      <Section
        index={1}
        titleId="help.s1.title"
        bodyId="help.s1.body"
        link={{ to: "/enrol", labelId: "help.s1.link" }}
      />

      <Section
        index={2}
        titleId="help.s2.title"
        bodyId="help.s2.body"
        link={{ to: "/admin", labelId: "help.s2.link" }}
      />

      <Section
        index={3}
        titleId="help.s3.title"
        bodyId="help.s3.body"
        link={{ to: "/admin", labelId: "help.s3.link" }}
      />

      <Section
        index={4}
        titleId="help.s4.title"
        bodyId="help.s4.body"
        link={{ to: "/catalog", labelId: "help.s4.link" }}
      />

      <Section
        index={5}
        titleId="help.s5.title"
        bodyId="help.s5.body"
        link={{ to: "/eod", labelId: "help.s5.link" }}
      />

      <footer className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        <p className="font-semibold text-neutral-900">
          <FormattedMessage id="help.printable.heading" />
        </p>
        <p className="mt-1">
          <FormattedMessage
            id="help.printable.body"
            values={{
              a: (chunks) => <code className="rounded bg-neutral-100 px-1">{chunks}</code>,
            }}
          />
        </p>
      </footer>
    </article>
  );
}

function Section({
  index,
  titleId,
  bodyId,
  link,
}: {
  index: number;
  titleId: string;
  bodyId: string;
  link: { to: string; labelId: string };
}) {
  return (
    <section className="space-y-2 rounded-md border border-neutral-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-neutral-900">
        <span className="text-primary-700">{index}.</span> <FormattedMessage id={titleId} />
      </h2>
      <FormattedMessage
        id={bodyId}
        values={{
          p: (chunks: ReactNode) => <p className="text-neutral-700">{chunks}</p>,
          strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
          code: (chunks: ReactNode) => (
            <code className="rounded bg-neutral-100 px-1 text-sm">{chunks}</code>
          ),
        }}
      />
      <Link
        to={link.to}
        className="inline-block rounded-md bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700 hover:bg-primary-100"
      >
        <FormattedMessage id={link.labelId} />
        {" →"}
      </Link>
    </section>
  );
}
