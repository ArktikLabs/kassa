import { useParams } from "@tanstack/react-router";
import { FormattedMessage } from "react-intl";

export function ReceiptScreen() {
  const { id } = useParams({ from: "/receipt/$id" });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold text-neutral-900">
        <FormattedMessage id="receipt.heading" />
      </h1>
      <p className="font-mono text-sm text-neutral-700">
        <FormattedMessage id="receipt.id" values={{ id }} />
      </p>
      <p className="text-neutral-600">
        <FormattedMessage id="receipt.placeholder" />
      </p>
    </section>
  );
}
