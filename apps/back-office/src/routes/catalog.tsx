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
import { createItem, setItemActive, updateItem } from "../data/store";
import { useCatalogItems } from "../data/useStore";
import {
  UNIT_OF_MEASURE_OPTIONS,
  type CatalogItem,
  type UnitOfMeasure,
} from "../data/types";
import { formatRupiah, parseRupiahInput } from "../lib/format";

type Draft = Omit<CatalogItem, "id">;

const EMPTY_DRAFT: Draft = {
  sku: "",
  name: "",
  priceIdr: 0,
  uom: "pcs",
  imageUrl: null,
  isStockTracked: false,
  isActive: true,
};

export function CatalogScreen() {
  const items = useCatalogItems();
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const startNew = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const startEdit = (row: CatalogItem) => {
    setEditing(row);
    setDraft({
      sku: row.sku,
      name: row.name,
      priceIdr: row.priceIdr,
      uom: row.uom,
      imageUrl: row.imageUrl,
      isStockTracked: row.isStockTracked,
      isActive: row.isActive,
    });
    setOpen(true);
  };

  const save = () => {
    if (editing) updateItem(editing.id, draft);
    else createItem(draft);
    setOpen(false);
  };

  const columns: DataTableColumn<CatalogItem>[] = [
    {
      key: "sku",
      header: <FormattedMessage id="catalog.col.sku" />,
      render: (r) => <code className="font-mono text-xs">{r.sku}</code>,
    },
    {
      key: "name",
      header: <FormattedMessage id="catalog.col.name" />,
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "price",
      header: <FormattedMessage id="catalog.col.price" />,
      numeric: true,
      render: (r) => formatRupiah(r.priceIdr),
    },
    {
      key: "uom",
      header: <FormattedMessage id="catalog.col.uom" />,
      render: (r) => r.uom,
    },
    {
      key: "stock",
      header: <FormattedMessage id="catalog.col.stock" />,
      align: "center",
      render: (r) => (r.isStockTracked ? "✓" : "—"),
    },
    {
      key: "active",
      header: <FormattedMessage id="catalog.col.active" />,
      align: "center",
      render: (r) =>
        r.isActive ? (
          <span className="rounded-full bg-success-surface px-2 py-0.5 text-xs font-semibold text-success-fg">
            ✓
          </span>
        ) : (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-600">
            —
          </span>
        ),
    },
    {
      key: "actions",
      header: <FormattedMessage id="catalog.col.actions" />,
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => startEdit(r)}>
            <FormattedMessage id="catalog.edit" />
          </Button>
          <Button
            variant={r.isActive ? "destructive" : "ghost"}
            onClick={() => setItemActive(r.id, !r.isActive)}
          >
            <FormattedMessage
              id={
                r.isActive ? "catalog.action.deactivate" : "catalog.action.activate"
              }
            />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="catalog.heading" />
        </h1>
        <Button onClick={startNew}>
          <FormattedMessage id="catalog.new" />
        </Button>
      </header>

      <DataTable
        rows={items}
        columns={columns}
        getRowId={(r) => r.id}
        caption={intl.formatMessage({ id: "catalog.heading" })}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing ? (
            <FormattedMessage id="catalog.edit" />
          ) : (
            <FormattedMessage id="catalog.new" />
          )
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <FormattedMessage id="catalog.form.cancel" />
            </Button>
            <Button onClick={save}>
              <FormattedMessage id="catalog.form.save" />
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={<FormattedMessage id="catalog.form.sku" />}
              htmlFor="item-sku"
            >
              <TextInput
                id="item-sku"
                name="sku"
                value={draft.sku}
                onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
              />
            </Field>
            <Field
              label={<FormattedMessage id="catalog.form.uom" />}
              htmlFor="item-uom"
            >
              <SelectInput
                id="item-uom"
                name="uom"
                value={draft.uom}
                onChange={(e) =>
                  setDraft({ ...draft, uom: e.target.value as UnitOfMeasure })
                }
              >
                {UNIT_OF_MEASURE_OPTIONS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Field
            label={<FormattedMessage id="catalog.form.name" />}
            htmlFor="item-name"
          >
            <TextInput
              id="item-name"
              name="name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field
            label={<FormattedMessage id="catalog.form.price" />}
            htmlFor="item-price"
          >
            <TextInput
              id="item-price"
              name="price"
              inputMode="numeric"
              value={draft.priceIdr === 0 ? "" : String(draft.priceIdr)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  priceIdr: parseRupiahInput(e.target.value),
                })
              }
            />
          </Field>
          <Field
            label={<FormattedMessage id="catalog.form.image" />}
            htmlFor="item-image"
          >
            <TextInput
              id="item-image"
              name="imageUrl"
              value={draft.imageUrl ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  imageUrl: e.target.value.trim() === "" ? null : e.target.value,
                })
              }
            />
          </Field>
          <div className="flex items-center gap-6">
            <Checkbox
              label={<FormattedMessage id="catalog.form.stock" />}
              checked={draft.isStockTracked}
              onChange={(e) =>
                setDraft({ ...draft, isStockTracked: e.target.checked })
              }
            />
            <Checkbox
              label={<FormattedMessage id="catalog.form.active" />}
              checked={draft.isActive}
              onChange={(e) =>
                setDraft({ ...draft, isActive: e.target.checked })
              }
            />
          </div>
        </div>
      </Modal>
    </section>
  );
}
