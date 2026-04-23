import { FormattedMessage } from "react-intl";

export function CatalogScreen() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-neutral-900">
        <FormattedMessage id="catalog.heading" />
      </h1>
      <p className="text-neutral-600">
        <FormattedMessage id="catalog.placeholder" />
      </p>
    </section>
  );
}
