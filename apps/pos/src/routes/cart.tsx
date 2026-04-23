import { FormattedMessage } from "react-intl";

export function CartScreen() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-neutral-900">
        <FormattedMessage id="cart.heading" />
      </h1>
      <p className="text-neutral-600">
        <FormattedMessage id="cart.placeholder" />
      </p>
    </section>
  );
}
