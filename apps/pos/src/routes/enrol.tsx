import { FormattedMessage } from "react-intl";

export function EnrolScreen() {
  return (
    <section className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold text-neutral-900">
        <FormattedMessage id="enrol.heading" />
      </h1>
      <p className="text-neutral-600">
        <FormattedMessage id="enrol.intro" />
      </p>
      <button
        type="button"
        className="h-14 w-full rounded-md bg-primary-600 font-semibold text-white hover:bg-primary-700"
      >
        <FormattedMessage id="enrol.cta" />
      </button>
    </section>
  );
}
