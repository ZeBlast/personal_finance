import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { categoryOptions } from "../../hooks/useCategories";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import { toast } from "../../lib/toast";
import type {
  ApplyResult,
  BatchUndoResult,
  Category,
  ChangeBatch,
  Rule,
  SavedRule,
  RuleChange,
  RuleDirection,
  RuleField,
  RuleOperator,
  RulePreview,
  Settings,
} from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { OwnNamesSection } from "./OwnNamesSection";
import {
  batchUndoText,
  FIELD_LABEL,
  OPERATOR_LABEL,
  ruleEffectText,
  ruleTotalsText,
} from "./ruleText";
import { buttonClass, inputClass, primaryClass, type Notice } from "./shared";

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

const PAGE = 50;

/** Puts a batch back and says what happened, in a toast; other views then reload. */
async function undoBatch(id: number, then?: () => void): Promise<void> {
  try {
    const result = await api<BatchUndoResult>(`/rules/batches/${id}/undo`, { method: "POST" });
    toast(batchUndoText(result));
    announceDataChanged();
  } catch (e) {
    toast(errorMessage(e, "Could not undo that."), { kind: "error" });
  }
  then?.();
}

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
  const [scope, setScope] = useState<"new" | "all">("all");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  // Changes beyond the first page, loaded by "Show more".
  const [more, setMore] = useState<RuleChange[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = categoryOptions(categories.filter((c) => c.active));
  const currency = useApi<Settings>("/settings").data?.currency ?? "USD";

  // What the preview asks about: the same things saving would use.
  const previewBody = useMemo(
    () => ({
      field,
      operator,
      matchValue,
      direction: direction || null,
      // With a category (and the rule being edited), it also says what would really change.
      ...(categoryId ? { categoryId: Number(categoryId) } : {}),
      ...(rule ? { ruleId: rule.id } : { scope }),
    }),
    [field, operator, matchValue, direction, categoryId, rule, scope],
  );

  const latestBody = useRef(previewBody);
  latestBody.current = previewBody;

  // Show how many existing transactions the rule matches, as it is being written.
  useEffect(() => {
    setMore([]);
    setPreviewError(null);
    if (matchValue.trim() === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<RulePreview>("/rules/preview", { method: "POST", body: JSON.stringify(previewBody) })
        .then((result) => !cancelled && setPreview(result))
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(errorMessage(e, "Could not work out what this rule would change."));
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewBody, matchValue]);

  const shown = [...(preview?.changes ?? []), ...more];

  async function showMore(): Promise<void> {
    const asked = previewBody;
    setLoadingMore(true);
    try {
      const next = await api<RulePreview>("/rules/preview", {
        method: "POST",
        body: JSON.stringify({ ...asked, offset: shown.length, limit: PAGE }),
      });
      // The inputs changed while this was loading: these rows belong to an older question.
      if (latestBody.current === asked) setMore((m) => [...m, ...(next.changes ?? [])]);
    } catch (e) {
      if (latestBody.current === asked) setError(errorMessage(e, "Could not load more."));
    } finally {
      setLoadingMore(false);
    }
  }

  // After a save that moved transactions: say how many, with a way to put them back.
  function announceMoved(saved: { batchId: number | null; changeCount: number }): void {
    if (saved.batchId === null) return;
    announceDataChanged();
    const batchId = saved.batchId;
    toast(`Moved ${saved.changeCount} transaction${saved.changeCount === 1 ? "" : "s"}.`, {
      action: { label: "Undo", run: () => undoBatch(batchId) },
    });
  }

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
        announceMoved(
          await api<SavedRule>(`/rules/${rule.id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...body, apply: true }),
          }),
        );
        onDone("Rule saved.");
      } else {
        announceMoved(
          await api<SavedRule>("/rules", {
            method: "POST",
            body: JSON.stringify({ ...body, scope }),
          }),
        );
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
        </div>
        {rule ? (
          <p className="text-xs text-slate-500">
            Saving re-files past transactions too; you can undo it.
          </p>
        ) : (
          <div>
            <span id={`${id}-scope`} className="block text-sm font-medium">
              Which transactions
            </span>
            <div
              role="radiogroup"
              aria-labelledby={`${id}-scope`}
              className="mt-1 inline-flex overflow-hidden rounded-md border border-slate-300 text-sm dark:border-slate-600"
            >
              {(
                [
                  ["new", "Only new transactions"],
                  ["all", "New and past transactions"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={scope === value}
                  onClick={() => setScope(value)}
                  className={`px-3 py-1.5 ${scope === value ? "bg-blue-600 font-medium text-white" : "hover:bg-slate-100 dark:hover:bg-slate-700"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {scope === "new"
                ? "Only transactions dated from today on."
                : "Past transactions are re-filed too, and you can undo it."}
            </p>
          </div>
        )}
        {previewError && (
          <p role="alert" className="text-xs text-red-600">
            {previewError}
          </p>
        )}
        {preview?.changeCount !== undefined && (
          // What saving really changes, after the order of the rules and hand-picked categories.
          <div className="rounded-md bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800">
            <p className="font-medium text-slate-700 dark:text-slate-200">
              {ruleEffectText(preview)}
            </p>
            {preview.totals && preview.totals.length > 0 && (
              <p className="mt-1 text-slate-600 dark:text-slate-300">
                Change to spending: {ruleTotalsText(preview.totals, currency)}
              </p>
            )}
            {shown.length > 0 && (
              <div className="mt-2 max-h-56 overflow-y-auto">
                <table className="w-full text-left">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-0.5 pr-2 font-medium">Date</th>
                      <th className="py-0.5 pr-2 font-medium">Merchant</th>
                      <th className="py-0.5 pr-2 text-right font-medium">Amount</th>
                      <th className="py-0.5 font-medium">Category</th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-600 dark:text-slate-300">
                    {shown.map((c) => (
                      <tr key={c.id}>
                        <td className="py-0.5 pr-2 whitespace-nowrap">{c.date}</td>
                        <td className="max-w-40 truncate py-0.5 pr-2">{c.merchant}</td>
                        <td className="py-0.5 pr-2 text-right whitespace-nowrap">
                          {formatMinor(c.amountMinor, currency)}
                        </td>
                        <td className="py-0.5">
                          {c.from ?? "Uncategorized"} → {c.to ?? "Uncategorized"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {shown.length < preview.changeCount && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void showMore()}
                className="mt-1 text-blue-600 hover:underline disabled:opacity-60 dark:text-blue-400"
              >
                {loadingMore ? "Loading..." : "Show more"}
              </button>
            )}
          </div>
        )}
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

  // null: the list of recent changes could not be loaded (the rules still show).
  const [batches, setBatches] = useState<ChangeBatch[] | null>([]);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(await api<Rule[]>("/rules"));
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not load the rules.") });
      setRules([]);
    }
    try {
      setBatches(await api<ChangeBatch[]>("/rules/batches"));
    } catch {
      setBatches(null);
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
                async () => {
                  const result = await api<ApplyResult>("/rules/apply", {
                    method: "POST",
                    body: "{}",
                  });
                  if (result.changed > 0) announceDataChanged();
                  return result;
                },
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

      {(batches === null || batches.length > 0) && (
        <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
          <summary className="cursor-pointer font-medium">Recent changes</summary>
          {batches === null && (
            <p className="mt-2 text-xs text-slate-500">Recent changes could not be loaded.</p>
          )}
          <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
            {batches?.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div>{b.label}</div>
                  <div className="text-xs text-slate-500">
                    {b.changeCount} transaction{b.changeCount === 1 ? "" : "s"} ·{" "}
                    {b.createdAt.slice(0, 10)}
                  </div>
                </div>
                {b.undoneAt !== null ? (
                  <span className="text-xs text-slate-500">Undone</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy || undoing}
                    className={buttonClass}
                    onClick={() => {
                      setUndoing(true);
                      void undoBatch(b.id, () => {
                        setUndoing(false);
                        void load();
                      });
                    }}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

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
