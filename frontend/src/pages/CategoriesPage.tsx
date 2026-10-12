import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../api/client";
import { MerchantsSection } from "../components/categories/MerchantsSection";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import type {
  ApplyResult,
  Category,
  Rule,
  RuleField,
  RuleOperator,
  RulePreview,
} from "../types/api";
import { Select } from "../components/common/Select";

type Notice = { kind: "info" | "error"; text: string };

const FIELD_LABEL: Record<RuleField, string> = {
  merchant: "Merchant",
  name: "Bank description",
  recipient: "Recipient",
  sender: "Sender",
  plaid_category: "Bank category",
};
const OPERATOR_LABEL: Record<RuleOperator, string> = {
  equals: "is exactly",
  contains: "contains",
  starts_with: "starts with",
  same_merchant: "is the same merchant as",
};

const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const buttonClass =
  "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";
const primaryClass =
  "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

function CategoryForm({
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

function CategoriesSection({ onChanged }: { onChanged: () => void }) {
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
          className={`rounded-md px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-100 text-red-900" : "bg-blue-100 text-blue-900"}`}
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

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

function RuleForm({
  rule,
  categories,
  onDone,
  onCancel,
}: {
  rule: Rule | null;
  categories: Category[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [field, setField] = useState<RuleField>(rule?.field ?? "merchant");
  const [operator, setOperator] = useState<RuleOperator>(rule?.operator ?? "contains");
  const [matchValue, setMatchValue] = useState(rule?.matchValue ?? "");
  const [categoryId, setCategoryId] = useState(rule ? String(rule.categoryId) : "");
  const [name, setName] = useState(rule?.name ?? "");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = categoryOptions(categories.filter((c) => c.active));

  // Show how many existing transactions the rule matches, as it is being written.
  useEffect(() => {
    if (matchValue.trim() === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<RulePreview>("/rules/preview", {
        method: "POST",
        body: JSON.stringify({ field, operator, matchValue }),
      })
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [field, operator, matchValue]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim() || `${FIELD_LABEL[field]} ${OPERATOR_LABEL[operator]} ${matchValue.trim()}`,
      field,
      operator,
      matchValue,
      categoryId: Number(categoryId),
    };
    try {
      if (rule) {
        await api(`/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onDone("Rule saved.");
      } else {
        await api("/rules", { method: "POST", body: JSON.stringify(body) });
        onDone("Rule added at the top of the list.");
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the rule."));
      setBusy(false);
    }
  }

  return (
    <Modal title={rule ? "Edit rule" : "New rule"} onClose={onCancel} wide>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-field`} className="block text-sm font-medium">
              When the
            </label>
            <Select
              id={`${id}-field`}
              value={field}
              onChange={(e) => setField(e.target.value as RuleField)}
              className={inputClass}
            >
              {(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => (
                <option key={f} value={f}>
                  {FIELD_LABEL[f]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor={`${id}-op`} className="block text-sm font-medium">
              ...
            </label>
            <Select
              id={`${id}-op`}
              value={operator}
              onChange={(e) => setOperator(e.target.value as RuleOperator)}
              className={inputClass}
            >
              {(Object.keys(OPERATOR_LABEL) as RuleOperator[]).map((o) => (
                <option key={o} value={o}>
                  {OPERATOR_LABEL[o]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-value`} className="block text-sm font-medium">
            This text (capitals do not matter)
          </label>
          <input
            id={`${id}-value`}
            value={matchValue}
            maxLength={200}
            autoFocus
            onChange={(e) => setMatchValue(e.target.value)}
            className={inputClass}
          />
          {preview && (
            <p className="mt-1 text-xs text-slate-500">
              Matches {preview.matchCount} existing transaction{preview.matchCount === 1 ? "" : "s"}
              {preview.sample.length > 0
                ? `, such as ${preview.sample
                    .slice(0, 3)
                    .map((s) => s.merchant)
                    .join(", ")}`
                : ""}
              .
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-cat`} className="block text-sm font-medium">
            Use this category
          </label>
          <Select
            id={`${id}-cat`}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
          >
            <option value="">Choose a category</option>
            {options.map((o) => (
              <option key={o.id} value={o.id} data-depth={o.depth}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="block text-sm font-medium">
            Rule name (optional)
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <p className="text-xs text-slate-500">
          Rules never change a category you chose yourself. New and updated transactions use the
          rules automatically; use “Apply rules now” to update the ones you already have.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || matchValue.trim() === "" || categoryId === ""}
            className={primaryClass}
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RulesSection({ categories }: { categories: Category[] }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await api<Rule[]>("/rules"));
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not load the rules.") });
      setRules([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, categories]);

  async function run<T>(action: () => Promise<T>, success: (result: T) => string): Promise<void> {
    setBusy(true);
    try {
      const result = await action();
      setNotice({ kind: "info", text: success(result) });
      await load();
    } catch (e) {
      setNotice({
        kind: "error",
        text: e instanceof ApiError ? e.message : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: -1 | 1): Promise<void> {
    if (!rules) return;
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    await run(
      () =>
        api<Rule[]>("/rules/reorder", {
          method: "POST",
          body: JSON.stringify({ orderedIds: next.map((r) => r.id) }),
        }),
      () => "Order changed. Use “Apply rules now” to update existing transactions.",
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Rules</h2>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() =>
              void run(
                () => api<ApplyResult>("/rules/apply", { method: "POST", body: "{}" }),
                (r) =>
                  r.changed === 0
                    ? "Everything already matches the rules."
                    : `Updated ${r.changed} transaction${r.changed === 1 ? "" : "s"}.`,
              )
            }
          >
            Apply rules now
          </button>
          <button type="button" className={primaryClass} onClick={() => setEditing("new")}>
            New rule
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Rules are tried from the top; the first one that matches decides the category. Categories
        you pick by hand are never changed by rules.
      </p>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-100 text-red-900" : "bg-blue-100 text-blue-900"}`}
        >
          {notice.text}
        </p>
      )}
      <ol className="divide-y divide-slate-200 rounded-lg border border-slate-200 px-3 dark:divide-slate-700 dark:border-slate-700">
        {rules?.map((r, index) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div className={r.enabled && r.categoryActive ? "" : "text-slate-400"}>
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-slate-500">
                {FIELD_LABEL[r.field]} {OPERATOR_LABEL[r.operator]} “{r.matchValue}” →{" "}
                {r.categoryName}
                {!r.categoryActive ? " (archived: rule is ignored)" : ""}
                {!r.enabled ? " · off" : ""}
              </div>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label={`Move ${r.name} up`}
                disabled={busy || index === 0}
                className={buttonClass}
                onClick={() => void move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${r.name} down`}
                disabled={busy || index === (rules?.length ?? 0) - 1}
                className={buttonClass}
                onClick={() => void move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={busy}
                className={buttonClass}
                onClick={() =>
                  void run(
                    () =>
                      api(`/rules/${r.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: !r.enabled }),
                      }),
                    () => (r.enabled ? "Rule turned off." : "Rule turned on."),
                  )
                }
              >
                {r.enabled ? "Turn off" : "Turn on"}
              </button>
              <button type="button" className={buttonClass} onClick={() => setEditing(r)}>
                Edit
              </button>
              <button
                type="button"
                className={`${buttonClass} border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
                onClick={() => setRemoving(r)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {rules !== null && rules.length === 0 && (
          <li className="py-4 text-sm text-slate-500">No rules yet.</li>
        )}
      </ol>

      {editing && (
        <RuleForm
          rule={editing === "new" ? null : editing}
          categories={categories}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            setNotice({ kind: "info", text });
            void load();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete the rule “${removing.name}”?`}
          message="Transactions it categorized are re-checked against the other rules; any that no longer match become uncategorized."
          confirmLabel="Delete rule"
          danger
          busy={busy}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(
              () => api(`/rules/${target.id}`, { method: "DELETE" }),
              () => `Deleted “${target.name}”.`,
            );
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

export function CategoriesPage() {
  const { categories, reload } = useCategories(true);
  // Assigning a merchant adds or changes a rule, so the rules list is rebuilt when it happens.
  const [rulesVersion, setRulesVersion] = useState(0);
  return (
    <section className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Categories and rules</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Organize your spending. Rules categorize transactions automatically, and you can always
          override a single transaction by hand.
        </p>
      </div>
      <CategoriesSection onChanged={() => void reload()} />
      <MerchantsSection
        categories={(categories ?? []).filter((c) => c.active)}
        onChanged={() => setRulesVersion((v) => v + 1)}
      />
      <RulesSection key={rulesVersion} categories={categories ?? []} />
    </section>
  );
}
