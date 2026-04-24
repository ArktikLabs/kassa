import { FormattedMessage } from "react-intl";

export function Forbidden() {
  return (
    <section className="mx-auto max-w-xl rounded-lg border border-warning-border bg-warning-surface p-8 text-center">
      <h1 className="text-2xl font-bold text-warning-fg">
        <FormattedMessage id="guard.forbidden.heading" />
      </h1>
      <p className="mt-2 text-sm text-neutral-700">
        <FormattedMessage id="guard.forbidden.body" />
      </p>
    </section>
  );
}
