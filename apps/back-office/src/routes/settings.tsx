import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { merchantSettings as merchantSettingsSchema } from "@kassa/schemas";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { updateMerchantSettings } from "../data/store";
import { useMerchantSettings } from "../data/useStore";
import type { MerchantSettings } from "../data/types";

/*
 * KASA-219 — owner-only merchant receipt branding form.
 *
 * Validation mirrors `@kassa/schemas#merchantSettings` so the back-office
 * never lets a value through that the API would reject. Optional fields
 * map to `null` when blank; required `displayName` is trimmed before
 * validation. The status banner is the same pattern as `outlets.tsx` so
 * the visual language stays consistent across the back-office.
 */

type Editable = Omit<MerchantSettings, "id" | "name">;

type FieldKey = keyof Editable;

type Errors = Partial<Record<FieldKey, string>>;

function nullable(input: string): string | null {
  const trimmed = input.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function toEditable(merchant: MerchantSettings): Editable {
  return {
    displayName: merchant.displayName,
    addressLine: merchant.addressLine,
    phone: merchant.phone,
    npwp: merchant.npwp,
    receiptFooterText: merchant.receiptFooterText,
  };
}

export function SettingsScreen() {
  const intl = useIntl();
  const merchant = useMerchantSettings();
  const [draft, setDraft] = useState<Editable>(() => toEditable(merchant));
  const [errors, setErrors] = useState<Errors>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed when the underlying row changes outside the form (e.g. another
  // tab) so the visible draft never drifts from the persisted state.
  useEffect(() => {
    setDraft(toEditable(merchant));
  }, [merchant]);

  const update = <K extends FieldKey>(key: K, value: Editable[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const { [key]: _omit, ...rest } = prev;
        return rest;
      });
    }
    setSavedAt(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const candidate: Editable = {
      displayName: draft.displayName.trim(),
      addressLine: draft.addressLine !== null ? nullable(draft.addressLine) : null,
      phone: draft.phone !== null ? nullable(draft.phone) : null,
      npwp: draft.npwp !== null ? nullable(draft.npwp) : null,
      receiptFooterText:
        draft.receiptFooterText !== null ? nullable(draft.receiptFooterText) : null,
    };
    const parsed = merchantSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldKey | undefined;
        if (key && next[key] === undefined) next[key] = issue.message;
      }
      setErrors(next);
      setSavedAt(null);
      return;
    }
    updateMerchantSettings(parsed.data);
    setErrors({});
    setSavedAt(Date.now());
  };

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="settings.heading" />
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600">
          <FormattedMessage id="settings.subheading" />
        </p>
      </header>

      <form
        onSubmit={submit}
        noValidate
        className="max-w-2xl space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm"
        aria-label={intl.formatMessage({ id: "settings.heading" })}
      >
        <Field
          label={<FormattedMessage id="settings.legalName" />}
          htmlFor="merchant-legal-name"
          hint={<FormattedMessage id="settings.legalName.hint" />}
        >
          <TextInput id="merchant-legal-name" value={merchant.name} readOnly disabled />
        </Field>

        <Field
          label={<FormattedMessage id="settings.displayName" />}
          htmlFor="merchant-display-name"
          hint={<FormattedMessage id="settings.displayName.hint" />}
          error={errors.displayName}
        >
          <TextInput
            id="merchant-display-name"
            name="displayName"
            value={draft.displayName}
            maxLength={80}
            onChange={(e) => update("displayName", e.target.value)}
          />
        </Field>

        <Field
          label={<FormattedMessage id="settings.addressLine" />}
          htmlFor="merchant-address"
          hint={<FormattedMessage id="settings.addressLine.hint" />}
          error={errors.addressLine}
        >
          <TextInput
            id="merchant-address"
            name="addressLine"
            value={draft.addressLine ?? ""}
            maxLength={160}
            onChange={(e) => update("addressLine", e.target.value)}
          />
        </Field>

        <Field
          label={<FormattedMessage id="settings.phone" />}
          htmlFor="merchant-phone"
          hint={<FormattedMessage id="settings.phone.hint" />}
          error={errors.phone}
        >
          <TextInput
            id="merchant-phone"
            name="phone"
            value={draft.phone ?? ""}
            maxLength={32}
            inputMode="tel"
            onChange={(e) => update("phone", e.target.value)}
          />
        </Field>

        <Field
          label={<FormattedMessage id="settings.npwp" />}
          htmlFor="merchant-npwp"
          hint={<FormattedMessage id="settings.npwp.hint" />}
          error={errors.npwp}
        >
          <TextInput
            id="merchant-npwp"
            name="npwp"
            value={draft.npwp ?? ""}
            maxLength={16}
            inputMode="numeric"
            onChange={(e) => update("npwp", e.target.value)}
          />
        </Field>

        <Field
          label={<FormattedMessage id="settings.footer" />}
          htmlFor="merchant-footer"
          hint={<FormattedMessage id="settings.footer.hint" />}
          error={errors.receiptFooterText}
        >
          <TextInput
            id="merchant-footer"
            name="receiptFooterText"
            value={draft.receiptFooterText ?? ""}
            maxLength={140}
            onChange={(e) => update("receiptFooterText", e.target.value)}
          />
        </Field>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit">
            <FormattedMessage id="settings.save" />
          </Button>
          {savedAt !== null ? (
            <p
              role="status"
              data-testid="settings-saved"
              className="rounded-md border border-success-border bg-success-surface px-3 py-1.5 text-xs text-success-fg"
            >
              <FormattedMessage id="settings.saved" />
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
