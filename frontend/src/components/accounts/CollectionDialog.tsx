import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import type { Account } from "../../types/api";
import { Modal } from "../common/Modal";
import { CardPricesPanel, PriceHistory } from "./CardPrices";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

/** The subtypes of collection accounts: collectibles valued by hand, and Pokemon cards. */
export const COLLECTION_SUBTYPE = "collection";
export const POKEMON_COLLECTION_SUBTYPE = "pokemon cards";
export const isCollection = (a: Pick<Account, "subtype" | "isManual">): boolean =>
  a.isManual && (a.subtype === COLLECTION_SUBTYPE || a.subtype === POKEMON_COLLECTION_SUBTYPE);

/** Card conditions, best to worst. Pokemon cards are Lightly Played unless they say otherwise. */
const CONDITIONS = [
  { code: "NM", label: "Near Mint (NM)" },
  { code: "LP", label: "Lightly Played (LP)" },
  { code: "MP", label: "Moderately Played (MP)" },
  { code: "HP", label: "Heavily Played (HP)" },
  { code: "DMG", label: "Damaged (DMG)" },
];
const DEFAULT_CONDITION = "LP";
const CONDITION_ORDER = new Map(CONDITIONS.map((c, n) => [c.code, n]));

/** "610583" or a pasted "https://www.tcgplayer.com/product/610583/..." → "610583". */
export function tcgplayerIdFrom(text: string): string | null {
  const t = text.trim();
  if (/^\d{1,12}$/.test(t)) return t;
  return /tcgplayer\.com\/product\/(\d{1,12})/i.exec(t)?.[1] ?? null;
}

interface Item {
  id: number;
  name: string;
  variant: string;
  setCode: string;
  number: string;
  quantity: number;
  unitValueMinor: number | null;
  unitCostMinor: number | null;
  totalValueMinor: number;
  condition: string | null;
  notes: string | null;
  valueSource: string | null;
  tcgplayerId: string | null;
  marketPriceMinor: number | null;
  priceUpdatedAt: string | null;
  priceMatchStatus: string | null;
  priceMatchLabel: string | null;
}

interface Collection {
  accountId: number;
  name: string;
  /** "pokemon": TCGplayer ids, conditions and market prices; "other": valued by hand. */
  type: "pokemon" | "other";
  items: Item[];
  totalValueMinor: number;
  totalQuantity: number;
  unvaluedItems: number;
}

interface ImportResult {
  parsed: { skipped: unknown[]; cards: unknown[]; totalQuantity: number };
  added: number;
  updated: number;
  collection: Collection | null;
}

const fields = (i: Item) => ({
  name: i.name,
  variant: i.variant,
  setCode: i.setCode,
  number: i.number,
  quantity: i.quantity,
  unitValueMinor: i.unitValueMinor,
  unitCostMinor: i.unitCostMinor,
  condition: i.condition,
  notes: i.notes,
});

type SortKey = "name" | "set" | "number" | "condition" | "quantity" | "market" | "value" | "total";
const SORTS: Record<SortKey, (i: Item) => string | number | null> = {
  name: (i) => `${i.name} ${i.variant}`,
  set: (i) => i.setCode,
  number: (i) => i.number,
  condition: (i) => CONDITION_ORDER.get(i.condition ?? DEFAULT_CONDITION) ?? 99,
  quantity: (i) => i.quantity,
  market: (i) => i.marketPriceMinor,
  value: (i) => i.unitValueMinor,
  total: (i) => (i.unitValueMinor === null ? null : i.totalValueMinor),
};
/** Sorted first-to-last on the first click (A to Z, best condition first). */
const TEXT_SORTS = new Set<SortKey>(["name", "set", "number", "condition"]);

const money = (minor: number | null) => (minor === null ? "" : (minor / 100).toFixed(2));

/** A value cell: edits in place, saves on Enter or leaving the field. */
function ValueCell({
  item,
  onSave,
}: {
  item: Item;
  onSave: (unitValueMinor: number | null) => Promise<void>;
}) {
  const [text, setText] = useState(money(item.unitValueMinor));
  const [bad, setBad] = useState(false);
  async function commit(): Promise<void> {
    const value = text.trim() === "" ? null : parseMoneyToMinor(text, "USD", { allowZero: true });
    if (text.trim() !== "" && value === null) {
      setBad(true);
      return;
    }
    setBad(false);
    if (value !== item.unitValueMinor) await onSave(value);
  }
  return (
    <input
      aria-label={`Value of one ${item.name}`}
      aria-invalid={bad}
      inputMode="decimal"
      value={text}
      placeholder="—"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`w-24 rounded border px-2 py-1 text-right tabular-nums dark:bg-slate-800 ${
        bad ? "border-red-500" : "border-slate-300 dark:border-slate-600"
      }`}
    />
  );
}

function ImportPanel({
  accountId,
  onDone,
  onCancel,
}: {
  accountId: number;
  onDone: (c: Collection, message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ImportResult>(`/accounts/${accountId}/collection/import`, {
        method: "POST",
        body: JSON.stringify({ text, preview: dryRun }),
      });
      if (dryRun) setPreview(result);
      else
        onDone(
          result.collection!,
          `Imported: ${result.added} new, ${result.updated} already there (quantities updated).`,
        );
    } catch (e) {
      setError(errorMessage(e, "Could not read that export."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
      <label htmlFor={`${id}-text`} className="block font-medium">
        Paste a TCGPlayer export
      </label>
      <p className="text-xs text-slate-500">
        One card per line, like “2 Pikachu - 025/165 [MEW] 025/165”. Cards already here get the
        export’s quantity; values you entered are kept.
      </p>
      <textarea
        id={`${id}-text`}
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        className={`${inputClass} font-mono text-xs`}
      />
      {preview && (
        <p role="status">
          {preview.parsed.cards.length} cards found: {preview.added} new, {preview.updated} already
          here.
          {preview.parsed.skipped.length > 0 &&
            ` ${preview.parsed.skipped.length} lines could not be read and will be skipped.`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {preview ? (
          <button
            type="button"
            className={primaryClass}
            disabled={busy}
            onClick={() => void run(false)}
          >
            {busy ? "Importing..." : "Import"}
          </button>
        ) : (
          <button
            type="button"
            className={primaryClass}
            disabled={busy || text.trim() === ""}
            onClick={() => void run(true)}
          >
            {busy ? "Reading..." : "Preview"}
          </button>
        )}
      </div>
    </div>
  );
}

function AddPanel({
  accountId,
  pokemon,
  onDone,
  onCancel,
}: {
  accountId: number;
  /** Pokemon cards need a TCGplayer id and a condition. */
  pokemon: boolean;
  onDone: (c: Collection, message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState({
    name: "",
    variant: "",
    setCode: "",
    number: "",
    qty: "1",
    value: "",
    tcgplayerId: "",
  });
  const [condition, setCondition] = useState<string>(DEFAULT_CONDITION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const quantity = Number(form.qty);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setError("Enter how many, as a whole number.");
      return;
    }
    const value =
      form.value.trim() === "" ? null : parseMoneyToMinor(form.value, "USD", { allowZero: true });
    if (form.value.trim() !== "" && value === null) {
      setError("Enter the value in dollars, for example 4.50, or leave it empty.");
      return;
    }
    const tcgplayerId = tcgplayerIdFrom(form.tcgplayerId);
    if (pokemon && !tcgplayerId) {
      setError(
        "Enter the card's TCGplayer id: the number in its tcgplayer.com/product/ link (or paste the link).",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api<Collection>(`/accounts/${accountId}/collection/items`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          variant: form.variant,
          setCode: form.setCode,
          number: form.number,
          quantity,
          unitValueMinor: value,
          ...(pokemon ? { tcgplayerId, condition } : {}),
        }),
      });
      onDone(c, `${form.name.trim()} was added.`);
    } catch (e) {
      setError(errorMessage(e, "Could not add the item."));
      setBusy(false);
    }
  }

  const field = (k: keyof typeof form, label: string, extra = "") => (
    <div className={extra}>
      <label htmlFor={`${id}-${k}`} className="block text-xs font-medium">
        {label}
      </label>
      <input id={`${id}-${k}`} value={form[k]} onChange={set(k)} className={inputClass} />
    </div>
  );

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {field("name", "Name", "col-span-2")}
        {field("variant", "Variant (optional)")}
        {field("setCode", "Set")}
        {field("number", "Number")}
        {field("qty", "How many")}
        {field("value", "Value of one (optional)", "col-span-2 sm:col-span-1")}
        {pokemon && field("tcgplayerId", "TCGplayer id", "col-span-2 sm:col-span-2")}
        {pokemon && (
          <div>
            <label htmlFor={`${id}-condition`} className="block text-xs font-medium">
              Condition
            </label>
            <select
              id={`${id}-condition`}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              className={inputClass}
            >
              {CONDITIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {pokemon && (
        <p className="text-xs text-slate-500">
          The TCGplayer id is the number at the end of the card's page on tcgplayer.com, as in
          tcgplayer.com/product/<strong>610583</strong>/. You can paste the whole link. Market
          prices are looked up by it, for the condition chosen.
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className={primaryClass}
          disabled={busy || form.name.trim() === "" || (pokemon && form.tcgplayerId.trim() === "")}
        >
          {busy ? "Adding..." : "Add"}
        </button>
      </div>
    </form>
  );
}

/**
 * A collection account's items: how many of each, and what one is worth. The account's balance
 * (and so net worth) is the sum of those values; items without a value count as nothing yet.
 */
export function CollectionDialog({
  account,
  onChanged,
  onClose,
}: {
  account: Account;
  onChanged: () => void;
  onClose: () => void;
}) {
  const loaded = useApi<Collection>(`/accounts/${account.id}/collection`);
  const [latest, setLatest] = useState<Collection | null>(null);
  const [panel, setPanel] = useState<"import" | "add" | "prices" | null>(null);
  const [historyOf, setHistoryOf] = useState<Item | null>(null);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const data = latest ?? loaded.data;
  const pokemon = data?.type === "pokemon";

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = data?.items ?? [];
    const filtered =
      q === ""
        ? items
        : items.filter((i) =>
            `${i.name} ${i.variant} ${i.setCode} ${i.number}`.toLowerCase().includes(q),
          );
    if (!sort) return filtered;
    const value = SORTS[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      // Items without a value (no price yet) stay at the bottom either way.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), undefined, { numeric: true })) * sign
      );
    });
  }, [data, filter, sort]);

  /** Money and counts start highest first, text A to Z; a third click goes back to set order. */
  function sortBy(key: SortKey): void {
    const first = TEXT_SORTS.has(key) ? "asc" : "desc";
    setSort((s) =>
      s?.key !== key
        ? { key, dir: first }
        : s.dir === first
          ? { key, dir: first === "asc" ? "desc" : "asc" }
          : null,
    );
  }

  const header = (key: SortKey, label: string, right = false) => {
    const active = sort?.key === key;
    return (
      <th
        className={`py-1 pr-2 ${right ? "text-right" : ""}`}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          onClick={() => sortBy(key)}
          className={`hover:text-slate-900 hover:underline dark:hover:text-slate-100 ${active ? "font-semibold text-slate-900 dark:text-slate-100" : ""}`}
        >
          {label}
          {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
        </button>
      </th>
    );
  };

  function apply(c: Collection, message?: string): void {
    setLatest(c);
    setPanel(null);
    if (message) setNotice({ kind: "info", text: message });
    onChanged();
  }

  async function save(item: Item, change: Partial<ReturnType<typeof fields>>): Promise<void> {
    try {
      const c = await api<Collection>(`/accounts/${account.id}/collection/items/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...fields(item), ...change }),
      });
      apply(c);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not save the change.") });
    }
  }

  async function remove(item: Item): Promise<void> {
    try {
      const c = await api<Collection>(`/accounts/${account.id}/collection/items/${item.id}`, {
        method: "DELETE",
      });
      apply(c, `${item.name} was removed.`);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not remove the item.") });
    }
  }

  const reloadAfterPrices = useCallback(() => {
    void api<Collection>(`/accounts/${account.id}/collection`).then((c) => {
      setLatest(c);
      onChanged();
    });
  }, [account.id, onChanged]);

  async function rematch(item: Item): Promise<void> {
    try {
      const c = await api<Collection>(
        `/accounts/${account.id}/collection/items/${item.id}/rematch`,
        { method: "POST" },
      );
      apply(c, `${item.name} will be searched for again on the next price update.`);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not reset the match.") });
    }
  }

  async function exportToFile(): Promise<void> {
    try {
      const file = await api<unknown>(`/accounts/${account.id}/collection/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${account.name.replace(/[^\w -]+/g, "").trim() || "collection"}.collection.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not export the collection.") });
    }
  }

  /** Closes on Escape or a click outside; a value still being typed is saved first. */
  function close(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    onClose();
  }

  return (
    <Modal title={account.name} onClose={close} wide="full" dismissible>
      <div className="space-y-3 text-sm">
        {data && (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span>
              Worth{" "}
              <strong className="tabular-nums">
                {formatMinor(data.totalValueMinor, account.currency)}
              </strong>
            </span>
            <span className="text-slate-500">
              {data.items.length} items · {data.totalQuantity} copies
              {data.unvaluedItems > 0 && ` · ${data.unvaluedItems} without a value yet`}
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Filter items"
            placeholder="Filter by name, set or number"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${inputClass} max-w-xs`}
          />
          <span className="flex-1" />
          {pokemon && (
            <button type="button" className={buttonClass} onClick={() => setPanel("prices")}>
              Market prices
            </button>
          )}
          <button type="button" className={buttonClass} onClick={() => setPanel("add")}>
            Add item
          </button>
          <button type="button" className={buttonClass} onClick={() => setPanel("import")}>
            Import export
          </button>
          <button
            type="button"
            className={buttonClass}
            title="Save the collection (items, prices and their history) to a file, to import in another copy of the app. The price service's key is not included."
            onClick={() => void exportToFile()}
          >
            Export to file
          </button>
        </div>
        {notice && (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={
              notice.kind === "error" ? "text-red-600" : "text-green-700 dark:text-green-400"
            }
          >
            {notice.text}
          </p>
        )}
        {panel === "import" && (
          <ImportPanel accountId={account.id} onDone={apply} onCancel={() => setPanel(null)} />
        )}
        {panel === "prices" && pokemon && (
          <CardPricesPanel accountId={account.id} onUpdated={reloadAfterPrices} />
        )}
        {historyOf && (
          <PriceHistory
            key={historyOf.id}
            accountId={account.id}
            itemId={historyOf.id}
            title={historyOf.name}
            currency={account.currency}
            onClose={() => setHistoryOf(null)}
          />
        )}
        {panel === "add" && (
          <AddPanel
            accountId={account.id}
            pokemon={pokemon}
            onDone={apply}
            onCancel={() => setPanel(null)}
          />
        )}
        {loaded.error && !data && (
          <p role="alert" className="text-red-600">
            {loaded.error}
          </p>
        )}
        {data && data.items.length === 0 && (
          <p className="text-slate-500">
            No items yet. Import an export from TCGPlayer, or add items one at a time.
          </p>
        )}
        {shown.length > 0 && (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-white text-xs text-slate-500 dark:bg-slate-900">
                <tr>
                  {header("name", "Name")}
                  {header("set", "Set")}
                  {header("number", "Number")}
                  {pokemon && header("condition", "Condition")}
                  {header("quantity", "How many", true)}
                  {pokemon && header("market", "Market", true)}
                  {header("value", "Value of one", true)}
                  {header("total", "Total", true)}
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1 pr-2">
                      {i.name}
                      {i.variant && <span className="text-slate-500"> ({i.variant})</span>}
                    </td>
                    <td className="py-1 pr-2">{i.setCode}</td>
                    <td
                      className="py-1 pr-2 tabular-nums"
                      title={
                        i.tcgplayerId ? `TCGplayer id ${i.tcgplayerId}` : "No TCGplayer id yet"
                      }
                    >
                      {i.number}
                    </td>
                    {pokemon && (
                      <td className="py-1 pr-2">
                        <select
                          aria-label={`Condition of ${i.name}`}
                          value={i.condition ?? DEFAULT_CONDITION}
                          title="Prices are looked up for this condition"
                          onChange={(e) => void save(i, { condition: e.target.value })}
                          className="rounded border border-slate-300 px-1 py-1 dark:border-slate-600 dark:bg-slate-800"
                        >
                          {CONDITIONS.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td className="py-1 pr-2 text-right">
                      <input
                        aria-label={`How many ${i.name}`}
                        type="number"
                        min={0}
                        defaultValue={i.quantity}
                        key={`${i.id}-${i.quantity}`}
                        onBlur={(e) => {
                          const q = Number(e.target.value);
                          if (Number.isInteger(q) && q >= 0 && q !== i.quantity)
                            void save(i, { quantity: q });
                        }}
                        className="w-16 rounded border border-slate-300 px-2 py-1 text-right dark:border-slate-600 dark:bg-slate-800"
                      />
                    </td>
                    {pokemon && (
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {i.marketPriceMinor !== null ? (
                          <button
                            type="button"
                            className="hover:underline"
                            title={i.priceMatchLabel ?? undefined}
                            aria-label={`Price history of ${i.name}`}
                            onClick={() => setHistoryOf(i)}
                          >
                            {formatMinor(i.marketPriceMinor, account.currency)}
                          </button>
                        ) : i.priceMatchStatus === "not_found" ? (
                          <button
                            type="button"
                            className="text-xs text-amber-700 hover:underline dark:text-amber-400"
                            title="Not found on JustTCG. Click to search again next time."
                            onClick={() => void rematch(i)}
                          >
                            not found
                          </button>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    )}
                    <td className="py-1 pr-2 text-right">
                      {i.valueSource === "manual" && i.marketPriceMinor !== null && (
                        <span
                          className="mr-1 text-xs text-slate-500"
                          title="Typed in; price updates keep it. Clear it to use the market price."
                        >
                          set by you
                        </span>
                      )}
                      <ValueCell
                        key={`${i.id}-${i.unitValueMinor}`}
                        item={i}
                        onSave={(v) => save(i, { unitValueMinor: v })}
                      />
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {i.unitValueMinor === null
                        ? "—"
                        : formatMinor(i.totalValueMinor, account.currency)}
                    </td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        className="text-xs text-red-700 hover:underline dark:text-red-400"
                        aria-label={`Remove ${i.name}`}
                        onClick={() => void remove(i)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
