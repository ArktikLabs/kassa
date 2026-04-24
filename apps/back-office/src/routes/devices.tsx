import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Field, SelectInput } from "../components/Field";
import { Modal } from "../components/Modal";
import { createEnrolmentCode, revokeDevice } from "../data/store";
import { useDevices, useEnrolmentCodes, useOutlets } from "../data/useStore";
import type { Device, EnrolmentCode } from "../data/types";

export function DevicesScreen() {
  const devices = useDevices();
  const codes = useEnrolmentCodes();
  const outlets = useOutlets();
  const intl = useIntl();
  const outletById = useMemo(() => new Map(outlets.map((o) => [o.id, o])), [outlets]);
  const [open, setOpen] = useState(false);
  const [selectedOutlet, setSelectedOutlet] = useState(outlets[0]?.id ?? "");

  const deviceColumns: DataTableColumn<Device>[] = [
    {
      key: "label",
      header: <FormattedMessage id="devices.col.label" />,
      render: (r) => <span className="font-medium">{r.label}</span>,
    },
    {
      key: "outlet",
      header: <FormattedMessage id="devices.col.outlet" />,
      render: (r) => outletById.get(r.outletId)?.name ?? r.outletId,
    },
    {
      key: "last_seen",
      header: <FormattedMessage id="devices.col.last_seen" />,
      render: (r) => (r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "—"),
    },
    {
      key: "status",
      header: <FormattedMessage id="devices.col.status" />,
      render: (r) => r.status,
    },
    {
      key: "actions",
      header: <FormattedMessage id="devices.col.actions" />,
      align: "right",
      render: (r) =>
        r.status === "active" ? (
          <Button variant="destructive" onClick={() => revokeDevice(r.id)}>
            <FormattedMessage id="devices.action.revoke" />
          </Button>
        ) : null,
    },
  ];

  const codeColumns: DataTableColumn<EnrolmentCode>[] = [
    {
      key: "code",
      header: <FormattedMessage id="devices.codes.col.code" />,
      render: (c) => <code className="font-mono text-sm">{c.code}</code>,
    },
    {
      key: "outlet",
      header: <FormattedMessage id="devices.codes.col.outlet" />,
      render: (c) => outletById.get(c.outletId)?.name ?? c.outletId,
    },
    {
      key: "expires",
      header: <FormattedMessage id="devices.codes.col.expires" />,
      render: (c) => new Date(c.expiresAt).toLocaleString(),
    },
    {
      key: "status",
      header: <FormattedMessage id="devices.codes.col.status" />,
      render: (c) => c.status,
    },
  ];

  const issue = () => {
    if (!selectedOutlet) return;
    createEnrolmentCode(selectedOutlet);
    setOpen(false);
  };

  return (
    <section className="space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="devices.heading" />
        </h1>
        <Button onClick={() => setOpen(true)} disabled={outlets.length === 0}>
          <FormattedMessage id="devices.new" />
        </Button>
      </header>

      <DataTable
        rows={devices}
        columns={deviceColumns}
        getRowId={(r) => r.id}
        caption={intl.formatMessage({ id: "devices.heading" })}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900">
          <FormattedMessage id="devices.codes.heading" />
        </h2>
        <DataTable
          rows={codes}
          columns={codeColumns}
          getRowId={(c) => c.code}
          caption={intl.formatMessage({ id: "devices.codes.heading" })}
        />
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={<FormattedMessage id="devices.new" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <FormattedMessage id="outlets.form.cancel" />
            </Button>
            <Button onClick={issue} disabled={!selectedOutlet}>
              <FormattedMessage id="outlets.form.generate_code" />
            </Button>
          </>
        }
      >
        <Field label={<FormattedMessage id="devices.col.outlet" />} htmlFor="code-outlet">
          <SelectInput
            id="code-outlet"
            value={selectedOutlet}
            onChange={(e) => setSelectedOutlet(e.target.value)}
          >
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </Modal>
    </section>
  );
}
