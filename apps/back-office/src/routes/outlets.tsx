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
};

export function OutletsScreen() {
  const outlets = useOutlets();
  const intl = useIntl();
  const [editing, setEditing] = useState<Outlet | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [codeIssuedFor, setCodeIssuedFor] = useState<{
    outletId: string;
    code: string;
    expiresAt: string;
  } | null>(null);

  const startNew = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const startEdit = (row: Outlet) => {
    setEditing(row);
    setDraft({
      name: row.name,
      taxProfile: row.taxProfile,
      receiptHeader: row.receiptHeader,
      addressLine: row.addressLine,
    });
    setOpen(true);
  };

  const save = () => {
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
        </div>
      </Modal>
    </section>
  );
}
