import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import {
  Checkbox,
  Field,
  SelectInput,
  TextInput,
} from "../components/Field";
import { Modal } from "../components/Modal";
import { createStaff, resetStaffPin, updateStaff } from "../data/store";
import { useStaff } from "../data/useStore";
import { STAFF_ROLES, type StaffRole } from "../lib/session";
import type { Staff } from "../data/types";

type Draft = Omit<Staff, "id">;

const EMPTY_DRAFT: Draft = {
  displayName: "",
  email: "",
  role: "cashier",
  pin: "",
  isActive: true,
};

export function StaffScreen() {
  const staff = useStaff();
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const startNew = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const startEdit = (row: Staff) => {
    setEditing(row);
    setDraft({
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      pin: row.pin,
      isActive: row.isActive,
    });
    setOpen(true);
  };

  const save = () => {
    if (editing) updateStaff(editing.id, draft);
    else createStaff(draft);
    setOpen(false);
  };

  const resetPin = (row: Staff) => {
    const next = (Math.floor(Math.random() * 9000) + 1000).toString();
    resetStaffPin(row.id, next);
    alert(
      intl.formatMessage(
        { id: "staff.form.reset_pin" },
      ) + `: ${next}`,
    );
  };

  const columns: DataTableColumn<Staff>[] = [
    {
      key: "name",
      header: <FormattedMessage id="staff.col.name" />,
      render: (r) => <span className="font-medium">{r.displayName}</span>,
    },
    {
      key: "email",
      header: <FormattedMessage id="staff.col.email" />,
      render: (r) => <span className="text-neutral-600">{r.email}</span>,
    },
    {
      key: "role",
      header: <FormattedMessage id="staff.col.role" />,
      render: (r) => <FormattedMessage id={`staff.role.${r.role}`} />,
    },
    {
      key: "active",
      header: <FormattedMessage id="staff.col.active" />,
      align: "center",
      render: (r) => (r.isActive ? "✓" : "—"),
    },
    {
      key: "actions",
      header: <FormattedMessage id="staff.col.actions" />,
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => startEdit(r)}>
            <FormattedMessage id="staff.edit" />
          </Button>
          <Button variant="ghost" onClick={() => resetPin(r)}>
            <FormattedMessage id="staff.form.reset_pin" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="staff.heading" />
        </h1>
        <Button onClick={startNew}>
          <FormattedMessage id="staff.new" />
        </Button>
      </header>

      <DataTable
        rows={staff}
        columns={columns}
        getRowId={(r) => r.id}
        caption={intl.formatMessage({ id: "staff.heading" })}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing ? (
            <FormattedMessage id="staff.edit" />
          ) : (
            <FormattedMessage id="staff.new" />
          )
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <FormattedMessage id="staff.form.cancel" />
            </Button>
            <Button onClick={save}>
              <FormattedMessage id="staff.form.save" />
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label={<FormattedMessage id="staff.form.name" />}
            htmlFor="staff-name"
          >
            <TextInput
              id="staff-name"
              value={draft.displayName}
              onChange={(e) =>
                setDraft({ ...draft, displayName: e.target.value })
              }
            />
          </Field>
          <Field
            label={<FormattedMessage id="staff.form.email" />}
            htmlFor="staff-email"
          >
            <TextInput
              id="staff-email"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={<FormattedMessage id="staff.form.role" />}
              htmlFor="staff-role"
            >
              <SelectInput
                id="staff-role"
                value={draft.role}
                onChange={(e) =>
                  setDraft({ ...draft, role: e.target.value as StaffRole })
                }
              >
                {STAFF_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {intl.formatMessage({ id: `staff.role.${r}` })}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field
              label={<FormattedMessage id="staff.form.pin" />}
              htmlFor="staff-pin"
            >
              <TextInput
                id="staff-pin"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                value={draft.pin}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    pin: e.target.value.replace(/[^0-9]/g, "").slice(0, 4),
                  })
                }
              />
            </Field>
          </div>
          <Checkbox
            label={<FormattedMessage id="staff.form.active" />}
            checked={draft.isActive}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          />
        </div>
      </Modal>
    </section>
  );
}
