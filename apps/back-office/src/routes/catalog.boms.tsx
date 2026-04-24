import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Button } from "../components/Button";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Field, SelectInput, TextInput } from "../components/Field";
import { Modal } from "../components/Modal";
import { createBom, updateBom } from "../data/store";
import { useBoms, useCatalogItems } from "../data/useStore";
import {
  UNIT_OF_MEASURE_OPTIONS,
  type Bom,
  type BomComponent,
  type UnitOfMeasure,
} from "../data/types";

type Draft = Omit<Bom, "id">;

const EMPTY_DRAFT: Draft = {
  parentItemId: "",
  components: [],
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: null,
};

export function BomsScreen() {
  const boms = useBoms();
  const items = useCatalogItems();
  const intl = useIntl();
  const itemsById = useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Bom | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const startNew = () => {
    setEditing(null);
    setDraft({
      ...EMPTY_DRAFT,
      parentItemId: items[0]?.id ?? "",
      components: items[1]
        ? [{ componentItemId: items[1].id, qty: 1, uom: items[1].uom }]
        : [],
    });
    setOpen(true);
  };

  const startEdit = (row: Bom) => {
    setEditing(row);
    setDraft({
      parentItemId: row.parentItemId,
      components: row.components.map((c) => ({ ...c })),
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    });
    setOpen(true);
  };

  const save = () => {
    if (editing) updateBom(editing.id, draft);
    else createBom(draft);
    setOpen(false);
  };

  const updateComponent = (index: number, patch: Partial<BomComponent>) => {
    setDraft((d) => ({
      ...d,
      components: d.components.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    }));
  };

  const addComponent = () => {
    setDraft((d) => ({
      ...d,
      components: [
        ...d.components,
        {
          componentItemId: items[0]?.id ?? "",
          qty: 1,
          uom: items[0]?.uom ?? "pcs",
        },
      ],
    }));
  };

  const removeComponent = (index: number) => {
    setDraft((d) => ({
      ...d,
      components: d.components.filter((_, i) => i !== index),
    }));
  };

  const columns: DataTableColumn<Bom>[] = [
    {
      key: "parent",
      header: <FormattedMessage id="boms.col.parent" />,
      render: (r) => itemsById.get(r.parentItemId)?.name ?? "—",
    },
    {
      key: "components",
      header: <FormattedMessage id="boms.col.components" />,
      render: (r) => (
        <ul className="space-y-0.5">
          {r.components.map((c) => (
            <li key={c.componentItemId} className="text-xs text-neutral-600">
              {itemsById.get(c.componentItemId)?.name ?? c.componentItemId} ·{" "}
              <span className="tabular-nums">{c.qty}</span>
              {" "}
              {c.uom}
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "effective",
      header: <FormattedMessage id="boms.col.effective" />,
      render: (r) =>
        r.effectiveTo
          ? `${r.effectiveFrom} → ${r.effectiveTo}`
          : `${r.effectiveFrom} →`,
    },
    {
      key: "actions",
      header: <FormattedMessage id="boms.col.actions" />,
      align: "right",
      render: (r) => (
        <Button variant="ghost" onClick={() => startEdit(r)}>
          <FormattedMessage id="boms.edit" />
        </Button>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="boms.heading" />
        </h1>
        <Button onClick={startNew} disabled={items.length < 2}>
          <FormattedMessage id="boms.new" />
        </Button>
      </header>

      <DataTable
        rows={boms}
        columns={columns}
        getRowId={(r) => r.id}
        caption={intl.formatMessage({ id: "boms.heading" })}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          editing ? (
            <FormattedMessage id="boms.edit" />
          ) : (
            <FormattedMessage id="boms.new" />
          )
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <FormattedMessage id="boms.form.cancel" />
            </Button>
            <Button onClick={save}>
              <FormattedMessage id="boms.form.save" />
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label={<FormattedMessage id="boms.form.parent" />}
            htmlFor="bom-parent"
          >
            <SelectInput
              id="bom-parent"
              value={draft.parentItemId}
              onChange={(e) =>
                setDraft({ ...draft, parentItemId: e.target.value })
              }
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={<FormattedMessage id="boms.form.from" />}
              htmlFor="bom-from"
            >
              <TextInput
                id="bom-from"
                type="date"
                value={draft.effectiveFrom}
                onChange={(e) =>
                  setDraft({ ...draft, effectiveFrom: e.target.value })
                }
              />
            </Field>
            <Field
              label={<FormattedMessage id="boms.form.to" />}
              htmlFor="bom-to"
            >
              <TextInput
                id="bom-to"
                type="date"
                value={draft.effectiveTo ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    effectiveTo:
                      e.target.value.trim() === "" ? null : e.target.value,
                  })
                }
              />
            </Field>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-neutral-800">
                <FormattedMessage id="boms.form.component" />
              </span>
              <Button variant="ghost" onClick={addComponent}>
                <FormattedMessage id="boms.form.add_component" />
              </Button>
            </div>
            <div className="space-y-2">
              {draft.components.map((comp, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-[1fr_96px_96px_auto] items-end gap-2"
                >
                  <SelectInput
                    aria-label={intl.formatMessage({
                      id: "boms.form.component",
                    })}
                    value={comp.componentItemId}
                    onChange={(e) =>
                      updateComponent(idx, { componentItemId: e.target.value })
                    }
                  >
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </SelectInput>
                  <TextInput
                    aria-label={intl.formatMessage({ id: "boms.form.qty" })}
                    type="number"
                    step="any"
                    min="0"
                    value={comp.qty}
                    onChange={(e) =>
                      updateComponent(idx, {
                        qty: Number.parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                  <SelectInput
                    aria-label={intl.formatMessage({ id: "boms.form.uom" })}
                    value={comp.uom}
                    onChange={(e) =>
                      updateComponent(idx, {
                        uom: e.target.value as UnitOfMeasure,
                      })
                    }
                  >
                    {UNIT_OF_MEASURE_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </SelectInput>
                  <Button
                    variant="ghost"
                    onClick={() => removeComponent(idx)}
                    aria-label="remove"
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </section>
  );
}
