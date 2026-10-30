import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions, useCategories } from "../../hooks/useCategories";
import type { Category } from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { buttonClass, inputClass, primaryClass, type Notice } from "./shared";

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

export function CategoryForm({
  category,
  categories,
  onDone,
  onCancel,
}: {
  category: Category | null;
  categories: Category[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(category?.name ?? "");
  const [parentId, setParentId] = useState(category?.parentId ? String(category.parentId) : "");
  const [color, setColor] = useState(category?.color ?? "#2563eb");
  const [treatment, setTreatment] = useState<string>(category?.incomeTreatment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A category that has subcategories stays at the top level, and only top-level, active ones can be parents.
  const hasChildren = category ? categories.some((c) => c.parentId === category.id) : false;
  const parents = categories.filter(
    (c) => c.parentId === null && c.active && c.id !== category?.id,
  );

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name,
      parentId: parentId === "" ? null : Number(parentId),
      color,
      incomeTreatment: treatment === "" ? null : treatment,
    };
    try {
      if (category) {
        await api(`/categories/${category.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onDone(`Saved “${name.trim()}”.`);
      } else {
        await api("/categories", { method: "POST", body: JSON.stringify(body) });
        onDone(`Added “${name.trim()}”.`);
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the category."));
      setBusy(false);
    }
  }

  return (
    <Modal title={category ? "Edit category" : "New category"} onClose={onCancel}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div>
          <label htmlFor={`${id}-name`} className="block text-sm font-medium">
            Name
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${id}-parent`} className="block text-sm font-medium">
            Inside
          </label>
          <Select
            id={`${id}-parent`}
            value={parentId}
            disabled={hasChildren}
            onChange={(e) => setParentId(e.target.value)}
            className={inputClass}
          >
            <option value="">Top level</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {hasChildren && (
            <p className="mt-1 text-xs text-slate-500">
              A category with subcategories stays at the top level.
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-color`} className="block text-sm font-medium">
            Color
          </label>
          <input
            id={`${id}-color`}
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="mt-1 h-9 w-16 rounded border border-slate-300 dark:border-slate-600"
          />
        </div>
        <div>
          <label htmlFor={`${id}-treatment`} className="block text-sm font-medium">
            Money here counts as
          </label>
          <Select
            id={`${id}-treatment`}
            value={treatment}
            onChange={(e) => setTreatment(e.target.value)}
            className={inputClass}
          >
            <option value="">
              The usual rules (income if it looks like pay or comes from someone)
            </option>
            <option value="income">Income (taxable), such as a credit you earned</option>
            <option value="refund">A refund: lowers spending, never income or taxable</option>
            <option value="transfer">
              Moving my own money (cash withdrawals, savings): never income or spending
            </option>
          </Select>
          <p className="mt-1 text-xs text-slate-500">
            Income counts toward income totals, the month report, and the sandbox&apos;s income
            figures; a refund only takes money off spending; moving your own money counts as
            neither, like a transfer between your accounts.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button type="submit" disabled={busy || name.trim() === ""} className={primaryClass}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CategoriesSection({ onChanged }: { onChanged: () => void }) {
  const { categories, reload } = useCategories(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [removing, setRemoving] = useState<Category | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [busy, setBusy] = useState(false);

  const all = categories ?? [];
  const top = all.filter((c) => c.parentId === null);
  const childrenOf = (id: number) => all.filter((c) => c.parentId === id);

  async function toggleActive(category: Category): Promise<void> {
    try {
      await api(`/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !category.active }),
      });
      setNotice({
        kind: "info",
        text: category.active ? `Archived “${category.name}”.` : `Restored “${category.name}”.`,
      });
      await reload();
      onChanged();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    }
  }

  async function remove(): Promise<void> {
    if (!removing) return;
    setBusy(true);
    try {
      const result = await api<{ outcome: "deleted" | "archived" }>(
        `/categories/${removing.id}${reassignTo ? `?reassignTo=${reassignTo}` : ""}`,
        { method: "DELETE" },
      );
      setNotice({
        kind: "info",
        text:
          result.outcome === "archived"
            ? `“${removing.name}” is in use, so it was archived instead of deleted.`
            : `Deleted “${removing.name}”.`,
      });
      setRemoving(null);
      setReassignTo("");
      await reload();
      onChanged();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not delete the category.") });
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  const row = (c: Category, indent: boolean) => (
    <li
      key={c.id}
      className={`flex flex-wrap items-center justify-between gap-2 py-2 ${indent ? "pl-8" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: c.color ?? "#94a3b8" }}
        />
        <span className={c.active ? "font-medium" : "text-slate-400 line-through"}>{c.name}</span>
        {!c.active && <span className="text-xs text-slate-500">archived</span>}
        {c.incomeTreatment && (
          <span
            className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300"
            title={
              c.incomeTreatment === "income"
                ? "Money coming in here counts as taxable income"
                : c.incomeTreatment === "refund"
                  ? "Money coming in here is a refund: it lowers spending and is never income"
                  : "Moving your own money: never income or spending, like a transfer"
            }
          >
            {c.incomeTreatment === "income"
              ? "counts as income"
              : c.incomeTreatment === "refund"
                ? "refund"
                : "moves your money"}
          </span>
        )}
        <span className="text-xs text-slate-500">
          {c.transactionCount} transaction{c.transactionCount === 1 ? "" : "s"}
          {c.ruleCount > 0 ? ` · ${c.ruleCount} rule${c.ruleCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing(c)}>
          Edit
        </button>
        <button type="button" className={buttonClass} onClick={() => void toggleActive(c)}>
          {c.active ? "Archive" : "Restore"}
        </button>
        <button
          type="button"
          className={`${buttonClass} border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
          onClick={() => setRemoving(c)}
        >
          Delete
        </button>
      </div>
    </li>
  );

  const reassignChoices = categoryOptions(all.filter((c) => c.active && c.id !== removing?.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Categories</h2>
        <button type="button" className={primaryClass} onClick={() => setEditing("new")}>
          New category
        </button>
      </div>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200" : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200"}`}
        >
          {notice.text}
        </p>
      )}
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 px-3 dark:divide-slate-700 dark:border-slate-700">
        {top.map((c) => (
          <li key={c.id} className="list-none">
            <ul>
              {row(c, false)}
              {childrenOf(c.id).map((k) => row(k, true))}
            </ul>
          </li>
        ))}
        {categories !== null && top.length === 0 && (
          <li className="py-4 text-sm text-slate-500">No categories yet.</li>
        )}
      </ul>

      {editing && (
        <CategoryForm
          category={editing === "new" ? null : editing}
          categories={all}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            setNotice({ kind: "info", text });
            void reload();
            onChanged();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Delete “${removing.name}”?`}
          message={
            <div className="space-y-3">
              <p>
                {removing.transactionCount + removing.ruleCount > 0 ||
                childrenOf(removing.id).length > 0
                  ? "This category is in use, so by default it is archived: it disappears from pickers but your history keeps its meaning. To remove it completely, move everything to another category:"
                  : "It is not used anywhere, so it will be deleted for good."}
              </p>
              {removing.transactionCount + removing.ruleCount > 0 &&
                childrenOf(removing.id).length === 0 && (
                  <label className="block">
                    <span className="font-medium">Move its transactions and rules to</span>
                    <Select
                      value={reassignTo}
                      onChange={(e) => setReassignTo(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">Nothing: just archive it</option>
                      {reassignChoices.map((o) => (
                        <option key={o.id} value={o.id} data-depth={o.depth}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
            </div>
          }
          confirmLabel={reassignTo ? "Move and delete" : "Delete"}
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => {
            setRemoving(null);
            setReassignTo("");
          }}
        />
      )}
    </div>
  );
}
