import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Field, SelectInput, TextInput } from "../components/Field";
import { Modal } from "../components/Modal";
import { createEnrolmentCode, createOutlet, updateOutlet } from "../data/store";
import { useOutlets } from "../data/useStore";
import type { Outlet } from "../data/types";

type Draft = Omit<Outlet, "id">;

const EMPTY_DRAFT: Draft = {
  name: "",
  taxProfile: "none",
  receiptHeader: "",
  addressLine: "",
  displayName: "",
  addressLine1: "",
  addressLine2: "",
  taxId: "",
  receiptFooterLine1: "",
  receiptFooterLine2: "",
};

const RECEIPT_FOOTER_MAX = 32;

/* KASA-367 — strip every non-digit before validating so the merchant can
 * paste a formatted NPWP (`01.234.567.8-901.000`) and the form stores the
 * bare digits the wire schema requires. */
function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

function isValidNpwp(digits: string): boolean {
  return digits.length === 0 || /^\d{15,16}$/.test(digits);
}

/* Display the bare NPWP digits in the canonical `00.000.000.0-000.000`
 * mask (15 digits) or the 16-digit unified NIK-NPWP shape. */
export function formatNpwpForDisplay(digits: string): string {
  if (digits.length === 15) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}.${digits.slice(
      8,
      9,
    )}-${digits.slice(9, 12)}.${digits.slice(12, 15)}`;
  }
  if (digits.length === 16) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12, 16)}`;
  }
  return digits;
}

export function OutletsScreen() {
  const outlets = useOutlets();
  const intl = useIntl();
  const [editing, setEditing] = useState<Outlet | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [npwpError, setNpwpError] = useState(false);
  const [codeIssuedFor, setCodeIssuedFor] = useState<{
    outletId: string;
    code: string;
    expiresAt: string;
  } | null>(null);

  const startNew = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setNpwpError(false);
    setOpen(true);
  };

  const startEdit = (row: Outlet) => {
    setEditing(row);
    setDraft({
      name: row.name,
      taxProfile: row.taxProfile,
      receiptHeader: row.receiptHeader,
      addressLine: row.addressLine,
      displayName: row.displayName,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      taxId: row.taxId,
      receiptFooterLine1: row.receiptFooterLine1,
      receiptFooterLine2: row.receiptFooterLine2,
    });
    setNpwpError(false);
    setOpen(true);
  };

  const save = () => {
    if (!isValidNpwp(draft.taxId)) {
      setNpwpError(true);
      return;
    }
    if (editing) updateOutlet(editing.id, draft);
    else createOutlet(draft);
    setOpen(false);
  };

  const issueCode = (row: Outlet) => {
    const code = createEnrolmentCode(row.id);
    setCodeIssuedFor({
      outletId: row.id,
      code: code.code,
      expiresAt: code.expiresAt,
    });
  };

  const columns: DataTableColumn<Outlet>[] = [
    {
      key: "name",
      header: <FormattedMessage id="outlets.col.name" />,
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "tax",
      header: <FormattedMessage id="outlets.col.tax" />,
      render: (r) => (
        <FormattedMessage
          id={r.taxProfile === "ppn_11" ? "outlets.form.tax.ppn_11" : "outlets.form.tax.none"}
        />
      ),
    },
    {
      key: "address",
      header: <FormattedMessage id="outlets.col.address" />,
      render: (r) => <span className="text-neutral-600">{r.addressLine}</span>,
    },
    {
      key: "actions",
      header: <FormattedMessage id="outlets.col.actions" />,
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => startEdit(r)}>
            <FormattedMessage id="outlets.edit" />
          </Button>
          <Button variant="ghost" onClick={() => issueCode(r)}>
            <FormattedMessage id="outlets.form.generate_code" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="outlets.heading" />
        </h1>
        <Button onClick={startNew}>
          <FormattedMessage id="outlets.new" />
        </Button>
      </header>

      {codeIssuedFor ? (
        <div
          role="status"
          className="rounded-md border border-success-border bg-success-surface px-4 py-3 text-sm text-success-fg"
        >
          <FormattedMessage
            id="outlets.code.issued"
            values={{
              code: <code className="font-mono">{codeIssuedFor.code}</code>,
              expires: new Date(codeIssuedFor.expiresAt).toLocaleTimeString("id-ID"),
            }}
          />
        </div>
      ) : null}

      <DataTable
        rows={outlets}
        columns={columns}
        getRowId={(r) => r.id}
        caption={intl.formatMessage({ id: "outlets.heading" })}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing ? <FormattedMessage id="outlets.edit" /> : <FormattedMessage id="outlets.new" />
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <FormattedMessage id="outlets.form.cancel" />
            </Button>
            <Button onClick={save}>
              <FormattedMessage id="outlets.form.save" />
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={<FormattedMessage id="outlets.form.name" />} htmlFor="outlet-name">
            <TextInput
              id="outlet-name"
              name="name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={<FormattedMessage id="outlets.form.tax" />} htmlFor="outlet-tax">
            <SelectInput
              id="outlet-tax"
              name="taxProfile"
              value={draft.taxProfile}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  taxProfile: e.target.value as Outlet["taxProfile"],
                })
              }
            >
              <option value="none">{intl.formatMessage({ id: "outlets.form.tax.none" })}</option>
              <option value="ppn_11">
                {intl.formatMessage({ id: "outlets.form.tax.ppn_11" })}
              </option>
            </SelectInput>
          </Field>
          <Field label={<FormattedMessage id="outlets.form.receipt" />} htmlFor="outlet-receipt">
            <TextInput
              id="outlet-receipt"
              name="receiptHeader"
              value={draft.receiptHeader}
              onChange={(e) => setDraft({ ...draft, receiptHeader: e.target.value })}
            />
          </Field>
          <Field label={<FormattedMessage id="outlets.form.address" />} htmlFor="outlet-address">
            <TextInput
              id="outlet-address"
              name="addressLine"
              value={draft.addressLine}
              onChange={(e) => setDraft({ ...draft, addressLine: e.target.value })}
            />
          </Field>
          <div
            className="space-y-4 rounded-md border border-neutral-200 bg-neutral-50 p-4"
            data-testid="outlet-receipt-branding"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              <FormattedMessage id="outlets.form.receipt_branding" />
            </p>
            <Field
              label={<FormattedMessage id="outlets.form.display_name" />}
              hint={<FormattedMessage id="outlets.form.display_name.hint" />}
              htmlFor="outlet-display-name"
            >
              <TextInput
                id="outlet-display-name"
                name="displayName"
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
              />
            </Field>
            <Field
              label={<FormattedMessage id="outlets.form.address_line1" />}
              htmlFor="outlet-address-line1"
            >
              <TextInput
                id="outlet-address-line1"
                name="addressLine1"
                value={draft.addressLine1}
                onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })}
              />
            </Field>
            <Field
              label={<FormattedMessage id="outlets.form.address_line2" />}
              htmlFor="outlet-address-line2"
            >
              <TextInput
                id="outlet-address-line2"
                name="addressLine2"
                value={draft.addressLine2}
                onChange={(e) => setDraft({ ...draft, addressLine2: e.target.value })}
              />
            </Field>
            <Field
              label={<FormattedMessage id="outlets.form.tax_id" />}
              hint={<FormattedMessage id="outlets.form.tax_id.hint" />}
              error={npwpError ? <FormattedMessage id="outlets.form.tax_id.invalid" /> : undefined}
              htmlFor="outlet-tax-id"
            >
              <TextInput
                id="outlet-tax-id"
                name="taxId"
                inputMode="numeric"
                value={draft.taxId}
                onChange={(e) => {
                  const digits = digitsOnly(e.target.value);
                  setDraft({ ...draft, taxId: digits });
                  if (npwpError) setNpwpError(false);
                }}
                aria-invalid={npwpError ? "true" : undefined}
              />
            </Field>
            <Field
              label={<FormattedMessage id="outlets.form.footer_line1" />}
              hint={
                <FormattedMessage
                  id="outlets.form.footer_line.hint"
                  values={{ remaining: RECEIPT_FOOTER_MAX - draft.receiptFooterLine1.length }}
                />
              }
              htmlFor="outlet-footer-line1"
            >
              <TextInput
                id="outlet-footer-line1"
                name="receiptFooterLine1"
                maxLength={RECEIPT_FOOTER_MAX}
                value={draft.receiptFooterLine1}
                onChange={(e) => setDraft({ ...draft, receiptFooterLine1: e.target.value })}
              />
            </Field>
            <Field
              label={<FormattedMessage id="outlets.form.footer_line2" />}
              hint={
                <FormattedMessage
                  id="outlets.form.footer_line.hint"
                  values={{ remaining: RECEIPT_FOOTER_MAX - draft.receiptFooterLine2.length }}
                />
              }
              htmlFor="outlet-footer-line2"
            >
              <TextInput
                id="outlet-footer-line2"
                name="receiptFooterLine2"
                maxLength={RECEIPT_FOOTER_MAX}
                value={draft.receiptFooterLine2}
                onChange={(e) => setDraft({ ...draft, receiptFooterLine2: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Modal>
    </section>
  );
}
