import { useId, useState, type FormEvent } from "react";
import { Modal } from "../components/common/Modal";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { useApi } from "../hooks/useApi";
import type { Account } from "../types/api";
import { resolveConfig } from "./config";
import type { AnyWidget, ConfigField, ConfigValue, PlacedWidget } from "./types";
import { Select } from "../components/common/Select";

const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";

function FieldControl({
  field,
  value,
  accounts,
  categories,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  accounts: Account[];
  categories: Array<{ id: number; label: string; depth?: number }>;
  onChange: (value: ConfigValue) => void;
}) {
  const id = useId();
  const label = (
    <label htmlFor={id} className="block text-sm font-medium">
      {field.label}
    </label>
  );
  const help = field.help ? (
    <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">
      {field.help}
    </p>
  ) : null;
  const described = field.help ? `${id}-help` : undefined;

  switch (field.type) {
    case "boolean":
      return (
        <div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
              aria-describedby={described}
              className="mt-1"
            />
            <span className="font-medium">{field.label}</span>
          </label>
          {help}
        </div>
      );
    case "number":
      return (
        <div>
          {label}
          <input
            id={id}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={Number(value)}
            aria-describedby={described}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`${inputClass} w-28`}
          />
          <p className="mt-1 text-xs text-slate-500">
            From {field.min} to {field.max}.
          </p>
          {help}
        </div>
      );
    case "text":
      return (
        <div>
          {label}
          <input
            id={id}
            value={String(value)}
            maxLength={field.maxLength}
            aria-describedby={described}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
          {help}
        </div>
      );
    case "select":
      return (
        <div>
          {label}
          <Select
            id={id}
            value={String(value)}
            aria-describedby={described}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {help}
        </div>
      );
    case "account":
      return (
        <div>
          {label}
          <Select
            id={id}
            value={String(value)}
            aria-describedby={described}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            <option value="">{field.allLabel ?? "All accounts"}</option>
            {accounts
              .filter((a) => field.accountType === undefined || a.type === field.accountType)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
          {help}
        </div>
      );
    case "category":
      return (
        <div>
          {label}
          <Select
            id={id}
            value={String(value)}
            aria-describedby={described}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id} data-depth={c.depth}>
                {c.label}
              </option>
            ))}
          </Select>
          {help}
        </div>
      );
  }
}

/**
 * The settings form for any widget, built entirely from its `configFields`, so a widget needs no
 * settings UI of its own.
 */
export function WidgetSettingsDialog({
  widget,
  definition,
  onSave,
  onCancel,
}: {
  widget: PlacedWidget;
  definition: AnyWidget;
  onSave: (config: Record<string, ConfigValue>) => void;
  onCancel: () => void;
}) {
  const [config, setConfig] = useState<Record<string, ConfigValue>>(() =>
    resolveConfig(definition, widget.config),
  );
  const accounts = useApi<Account[]>("/accounts");
  const { categories } = useCategories();

  function submit(event: FormEvent): void {
    event.preventDefault();
    onSave(resolveConfig(definition, config)); // checked again, so a half-typed number cannot slip through
  }

  return (
    <Modal title={`${definition.title} settings`} onClose={onCancel}>
      <form onSubmit={submit} className="space-y-4">
        {(definition.configFields ?? []).map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={config[field.key] ?? ""}
            accounts={accounts.data ?? []}
            categories={categoryOptions(categories ?? [])}
            onChange={(value) => setConfig((c) => ({ ...c, [field.key]: value }))}
          />
        ))}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </form>
    </Modal>
  );
}
