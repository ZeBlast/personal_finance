import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import type {
  ApplyResult,
  Category,
  Rule,
  RuleDirection,
  RuleField,
  RuleOperator,
  RulePreview,
} from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { OwnNamesSection } from "./OwnNamesSection";
import { FIELD_LABEL, OPERATOR_LABEL, ruleEffectText } from "./ruleText";
import { buttonClass, inputClass, primaryClass, type Notice } from "./shared";

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

export function RuleForm({
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
  const [direction, setDirection] = useState<RuleDirection | "">(rule?.direction ?? "");
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
        body: JSON.stringify({
          field,
          operator,
          matchValue,
          direction: direction || null,
          // With a category (and the rule being edited), it also says what would really change.
          ...(categoryId ? { categoryId: Number(categoryId) } : {}),
          ...(rule ? { ruleId: rule.id } : {}),
        }),
      })
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [field, operator, matchValue, direction, categoryId, rule]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim() || `${FIELD_LABEL[field]} ${OPERATOR_LABEL[operator]} ${matchValue.trim()}`,
      field,
      operator,
      matchValue,
      direction: direction || null,
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
          <label htmlFor={`${id}-dir`} className="block text-sm font-medium">
            For money
          </label>
          <Select
            id={`${id}-dir`}
            value={direction}
            onChange={(e) => setDirection(e.target.value as RuleDirection | "")}
            className={inputClass}
          >
            <option value="">Going out or coming in</option>
            <option value="out">Going out only (purchases, payments)</option>
            <option value="in">Coming in only (refunds, credits, income)</option>
          </Select>
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
          {preview?.changeCount !== undefined && (
            // What saving really changes, after the order of the rules and hand-picked categories.
            <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800">
              <p className="font-medium text-slate-700 dark:text-slate-200">
                {ruleEffectText(preview)}
              </p>
              {preview.changes && preview.changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
                  {preview.changes.slice(0, 5).map((c) => (
                    <li key={c.id} className="flex justify-between gap-2">
                      <span className="truncate">
                        {c.date} · {c.merchant}
                      </span>
                      <span className="shrink-0">
                        {c.from ?? "Uncategorized"} → {c.to ?? "Uncategorized"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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

export function RulesSection({ categories }: { categories: Category[] }) {
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
      <OwnNamesSection onSaved={() => void load()} />
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200" : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200"}`}
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
                {r.direction === "out" ? " · money going out" : ""}
                {r.direction === "in" ? " · money coming in" : ""}
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
