import { useState, type ChangeEvent, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { today } from "../../lib/period";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import {
  buildAllocations,
  buildContribution,
  buildFetchRequest,
  draftFromContribution,
  emptyContributionDraft,
  employerAmount,
  estimateUnits,
  formatUnits,
  FREQUENCY_OPTIONS,
  HISTORY_OPTIONS,
  SOURCE_OPTIONS,
  type HistoryRange,
  type PriceSource,
  rowsFromAllocations,
  type AllocationRow,
  type ContributionDraft,
  type TspContribution,
  type TspFund,
  type TspSettings,
} from "../../lib/tsp";
import { ConfirmDialog, Modal } from "../common/Modal";
import { AllocationEditor } from "./AllocationEditor";
import { buttonClass, inputClass, primaryClass } from "./styles";
import { RetirementProjection } from "./RetirementProjection";
import { importTspActivity } from "./tspActivity";
import { Select } from "../common/Select";

type Notice = { kind: "info" | "error"; text: string };

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything specific to a Thrift Savings Plan kept by hand: how new money is split, the recurring
 * contributions that buy units at each day's price, and the fund prices that depend on.
 */
export function TspPanel({
  accountId,
  balanceMinor,
  onChanged,
}: {
  accountId: number;
  /** The account's current balance, for the retirement projection. */
  balanceMinor: number;
  onChanged: () => void;
}) {
  const settings = useApi<TspSettings>(`/accounts/${accountId}/tsp`);
  const funds = useApi<TspFund[]>("/tsp/funds");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<TspContribution | "new" | "once" | null>(null);
  const [deleting, setDeleting] = useState<TspContribution | null>(null);
  const [busy, setBusy] = useState(false);

  const data = settings.data;

  function changed(text?: string): void {
    if (text) setNotice({ kind: "info", text });
    settings.reload();
    funds.reload();
    onChanged();
    announceDataChanged();
  }

  async function run(work: () => Promise<string | void>, failure: string): Promise<void> {
    setBusy(true);
    try {
      const text = await work();
      changed(text ?? undefined);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, failure) });
    } finally {
      setBusy(false);
    }
  }

  if (settings.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {settings.error}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-slate-500">Loading the plan...</p>;

  return (
    <div className="space-y-4">
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
              : "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
          }`}
        >
          {notice.text}
        </p>
      )}

      {data.waiting.length > 0 && (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {data.waiting.length} contribution{data.waiting.length === 1 ? " is" : "s are"} waiting
          for fund prices (the earliest is {formatDay(data.waiting[0]!.date)}). Fetch or import the
          prices below and they will be added automatically.
        </p>
      )}

      <Section title="Where new contributions go">
        <AllocationSection
          settings={data}
          funds={funds.data ?? []}
          busy={busy}
          onSave={(allocations) =>
            void run(async () => {
              await api(`/accounts/${accountId}/tsp/allocations`, {
                method: "PUT",
                body: JSON.stringify({ allocations }),
              });
              return "The split was saved.";
            }, "Could not save the split.")
          }
          onError={(text) => setNotice({ kind: "error", text })}
        />
      </Section>

      <Section
        title="Contributions"
        action={
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setEditing("once")}>
              Add a one-time contribution
            </button>
            <button type="button" className={primaryClass} onClick={() => setEditing("new")}>
              Add a recurring contribution
            </button>
          </div>
        }
      >
        {data.contributions.length === 0 ? (
          <p className="text-sm text-slate-500">
            None yet. Add one, such as $500 every 2 weeks, and each time it comes due it is turned
            into fund units at that day&apos;s price.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {data.contributions.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">{c.description}</div>
                  <div className="text-xs text-slate-500">
                    from {formatDay(c.startDate)}
                    {c.endDate ? ` to ${formatDay(c.endDate)}` : ""}
                    {c.nextDate
                      ? ` · next ${formatDay(c.nextDate)}`
                      : c.active
                        ? " · no more due"
                        : ""}
                    {!c.active ? " · paused" : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${buttonClass} text-red-700 dark:text-red-400`}
                    aria-label={`Delete ${c.description}`}
                    onClick={() => setDeleting(c)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api<{ applied: number }>(`/accounts/${accountId}/tsp/apply`, {
                  method: "POST",
                });
                return r.applied > 0
                  ? `${r.applied} contribution${r.applied === 1 ? "" : "s"} turned into units.`
                  : "Nothing new was due.";
              }, "Could not update the account.")
            }
          >
            Update now
          </button>
        </div>
      </Section>

      <Section title="Fund prices">
        <PricesSection
          settings={data}
          funds={funds.data ?? []}
          busy={busy}
          run={run}
          onNotice={setNotice}
        />
      </Section>

      <Section title="Past activity">
        <ActivitySection accountId={accountId} busy={busy} run={run} />
      </Section>

      <Section title="Retirement projection">
        <RetirementProjection balanceMinor={balanceMinor} contributions={data.contributions} />
      </Section>

      {data.recent.length > 0 && (
        <Section title="Recent contributions">
          <ul className="space-y-1 text-sm">
            {data.recent.map((r) => (
              <li key={`${r.contributionId}-${r.date}`}>
                <span className="font-medium">{formatDay(r.date)}</span>{" "}
                <span className="tabular-nums">{formatMinor(r.amountMinor, "USD")}</span>
                {r.employerMinor > 0 && (
                  <span className="text-slate-500">
                    {" "}
                    (incl. {formatMinor(r.employerMinor, "USD")} from your employer)
                  </span>
                )}
                <span className="text-slate-500">
                  {" "}
                  →{" "}
                  {r.parts
                    .map((p) => `${formatUnits(p.units)} ${p.code} at $${p.price.toFixed(4)}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {editing && (
        <ContributionDialog
          settings={data}
          existing={editing === "new" || editing === "once" ? null : editing}
          oneTime={editing === "once"}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            changed(text);
          }}
          accountId={accountId}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this contribution?"
          message={`${deleting.description} will stop. What it already bought stays in the account.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              await api(`/tsp/contributions/${deleting.id}`, { method: "DELETE" });
              setDeleting(null);
              return "The contribution was deleted.";
            }, "Could not delete it.")
          }
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function AllocationSection({
  settings,
  funds,
  busy,
  onSave,
  onError,
}: {
  settings: TspSettings;
  funds: TspFund[];
  busy: boolean;
  onSave: (allocations: Array<{ symbol: string; percent: number }>) => void;
  onError: (message: string) => void;
}) {
  const [rows, setRows] = useState<AllocationRow[]>(() =>
    rowsFromAllocations(settings.allocations),
  );
  const saved = JSON.stringify(rowsFromAllocations(settings.allocations));
  const dirty = JSON.stringify(rows) !== saved;
  return (
    <div className="space-y-2">
      <AllocationEditor funds={funds} rows={rows} onChange={setRows} idPrefix="tsp-alloc" />
      <div className="flex justify-end gap-2">
        {dirty && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setRows(rowsFromAllocations(settings.allocations))}
          >
            Undo changes
          </button>
        )}
        <button
          type="button"
          className={primaryClass}
          disabled={busy || !dirty}
          onClick={() => {
            const built = buildAllocations(rows);
            if (!built.ok) onError(built.message);
            else onSave(built.allocations);
          }}
        >
          Save split
        </button>
      </div>
    </div>
  );
}

/**
 * Importing the TSP's Investment Activity Detail file into an account. Used in the account's TSP
 * panel and from the account's own Import button.
 */
export function ActivitySection({
  accountId,
  busy,
  run,
  defaultUpdateHoldings = false,
}: {
  accountId: number;
  busy: boolean;
  run: (work: () => Promise<string | void>, failure: string) => Promise<void>;
  /** Start with "add the units to the holdings" on (for an account that holds nothing yet). */
  defaultUpdateHoldings?: boolean;
}) {
  const [updateHoldings, setUpdateHoldings] = useState(defaultUpdateHoldings);

  async function importFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run(
      () => importTspActivity(accountId, file, updateHoldings),
      "Could not read that file.",
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-slate-600 dark:text-slate-300">
        Import the Investment Activity Detail file from tsp.gov to record what was really
        contributed (yours, the agency&apos;s automatic and matching amounts) with the units and
        prices of each day. Importing the same file twice is safe.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={updateHoldings}
          onChange={(e) => setUpdateHoldings(e.target.checked)}
          className="mt-1"
        />
        <span>
          Add the units in this file to what the account holds
          <span className="block text-xs text-slate-500">
            Leave this off if you already entered what the account holds today, or it would be
            counted twice. Turn off any recurring contribution that covers the same pay dates.
          </span>
        </span>
      </label>
      <label className={`${buttonClass} inline-block cursor-pointer`}>
        Import activity file (CSV)
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          disabled={busy}
          className="sr-only"
          onChange={(e) => void importFile(e)}
        />
      </label>
    </div>
  );
}

function PricesSection({
  settings,
  funds,
  busy,
  run,
  onNotice,
}: {
  settings: TspSettings;
  funds: TspFund[];
  busy: boolean;
  run: (work: () => Promise<string | void>, failure: string) => Promise<void>;
  onNotice: (n: Notice) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<PriceSource>("maxtsp");
  const [range, setRange] = useState<HistoryRange>("missing");
  const [since, setSince] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);

  async function importFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run(async () => {
      const csv = await file.text();
      const r = await api<{ days: number; prices: number; from: string | null; to: string | null }>(
        "/tsp/prices/import",
        { method: "POST", body: JSON.stringify({ csv }) },
      );
      return `Imported ${r.prices} prices for ${r.days} days${r.from && r.to ? ` (${formatDay(r.from)} to ${formatDay(r.to)})` : ""}.`;
    }, "Could not read that file.");
  }

  return (
    <div className="space-y-3">
      {settings.prices.length === 0 ? (
        <p className="text-sm text-slate-500">
          No prices yet. Fetch them, import a price file, or add one by hand.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th scope="col" className="pb-1 font-medium">
                Fund
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Newest price
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                As of
              </th>
            </tr>
          </thead>
          <tbody>
            {settings.prices.map((p) => (
              <tr key={p.symbol} className="border-t border-slate-100 dark:border-slate-700">
                <td className="py-1">{p.name}</td>
                <td className="py-1 text-right tabular-nums">
                  {p.price === null ? "no price yet" : `$${p.price.toFixed(4)}`}
                </td>
                <td className="py-1 text-right text-slate-500">
                  {p.date ? formatDay(p.date) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label htmlFor="price-source" className="block text-xs font-medium">
            Get prices from
          </label>
          <Select
            id="price-source"
            value={source}
            onChange={(e) => setSource(e.target.value as PriceSource)}
            className={inputClass}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="price-range" className="block text-xs font-medium">
            How far back (every day in that time is saved)
          </label>
          <Select
            id="price-range"
            value={range}
            onChange={(e) => setRange(e.target.value as HistoryRange)}
            className={inputClass}
          >
            {HISTORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {range === "since" && (
          <div>
            <label htmlFor="price-since" className="block text-xs font-medium">
              Held since
            </label>
            <input
              id="price-since"
              type="date"
              value={since}
              max={today()}
              onChange={(e) => setSince(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
      </div>
      {rangeError && (
        <p role="alert" className="text-sm text-red-600">
          {rangeError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => {
            const request = buildFetchRequest(source, range, since, today());
            if (!request.ok) {
              setRangeError(request.message);
              return;
            }
            setRangeError(null);
            void run(async () => {
              const r = await api<{ days: number; prices: number; upToDate?: boolean }>(
                "/tsp/prices/fetch",
                { method: "POST", body: JSON.stringify(request.body) },
              );
              return r.upToDate
                ? "Prices are already up to date. There are no newer days to fetch yet."
                : `Fetched ${r.prices} prices for ${r.days} days.`;
            }, "Could not download prices.");
          }}
        >
          Fetch prices
        </button>
        <label className={`${buttonClass} cursor-pointer`}>
          Import price file (CSV)
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => void importFile(e)}
          />
        </label>
        <button type="button" className={buttonClass} onClick={() => setAdding(true)}>
          Add a price
        </button>
      </div>
      <p className="text-xs text-slate-500">
        If a download is refused, get the price file from tsp.gov in your browser (Share Prices,
        then the CSV download) and import it here. Prices you type by hand are never replaced.
      </p>
      {adding && (
        <PriceDialog
          funds={funds}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onNotice({ kind: "info", text: "The price was saved." });
            void run(async () => undefined, "");
          }}
        />
      )}
    </div>
  );
}

function PriceDialog({
  funds,
  onClose,
  onSaved,
}: {
  funds: TspFund[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [symbol, setSymbol] = useState("TSP-C");
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = Number(price.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter the price of one unit as a positive number, such as 98.1234.");
      return;
    }
    setBusy(true);
    try {
      await api("/tsp/prices", {
        method: "POST",
        body: JSON.stringify({ symbol, date, price: value }),
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, "Could not save the price."));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a fund price" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div>
          <label htmlFor="price-fund" className="block font-medium">
            Fund
          </label>
          <Select
            id="price-fund"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className={inputClass}
          >
            {funds.map((f) => (
              <option key={f.symbol} value={f.symbol}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="price-date" className="block font-medium">
              Date
            </label>
            <input
              id="price-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="price-value" className="block font-medium">
              Price of one unit
            </label>
            <input
              id="price-value"
              inputMode="decimal"
              value={price}
              placeholder="98.1234"
              onChange={(e) => setPrice(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            Save price
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ContributionDialog({
  accountId,
  settings,
  existing,
  oneTime,
  onClose,
  onSaved,
}: {
  accountId: number;
  settings: TspSettings;
  existing: TspContribution | null;
  /** A new contribution made once, rather than on a schedule. */
  oneTime: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [draft, setDraft] = useState<ContributionDraft>(() =>
    existing
      ? draftFromContribution(existing)
      : emptyContributionDraft(today(), oneTime ? "once" : "biweekly"),
  );
  const once = draft.frequency === "once";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<ContributionDraft>): void => setDraft((d) => ({ ...d, ...change }));
  const monthly = draft.frequency === "monthly" || draft.frequency === "semimonthly";

  const built = buildContribution(draft);
  const ownMinor = built.ok ? (built.payload["amountMinor"] as number) : null;
  const employerMinor =
    built.ok && ownMinor !== null
      ? employerAmount({
          amountMinor: ownMinor,
          matchPlan: (built.payload["matchPlan"] as TspContribution["matchPlan"]) ?? null,
          payMinor: (built.payload["payMinor"] as number | undefined) ?? null,
          matchPercent: (built.payload["matchPercent"] as number | undefined) ?? null,
          matchUpToPercent: (built.payload["matchUpToPercent"] as number | undefined) ?? null,
          autoPercent: (built.payload["autoPercent"] as number | undefined) ?? null,
        })
      : 0;
  // What is bought each time: your money and the employer's.
  const amountMinor = ownMinor === null ? null : ownMinor + employerMinor;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api(`/tsp/contributions/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify(built.payload),
        });
        onSaved("The contribution was updated.");
      } else {
        const r = await api<{ applied: number }>(`/accounts/${accountId}/tsp/contributions`, {
          method: "POST",
          body: JSON.stringify(built.payload),
        });
        onSaved(
          r.applied > 0
            ? `Added. ${r.applied} contribution${r.applied === 1 ? "" : "s"} that came due so far ${r.applied === 1 ? "was" : "were"} turned into units.`
            : "The contribution was added.",
        );
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the contribution."));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        existing
          ? "Edit contribution"
          : once
            ? "Add a one-time contribution"
            : "Add a recurring contribution"
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="tsp-amount" className="block font-medium">
              {once ? "Amount" : "Amount of each contribution"}
            </label>
            <input
              id="tsp-amount"
              inputMode="decimal"
              value={draft.amount}
              placeholder="500.00"
              autoFocus
              onChange={(e) => set({ amount: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="tsp-frequency" className="block font-medium">
              How often
            </label>
            <Select
              id="tsp-frequency"
              value={draft.frequency}
              onChange={(e) => set({ frequency: e.target.value as ContributionDraft["frequency"] })}
              className={inputClass}
            >
              {FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tsp-start" className="block font-medium">
              {once ? "Date" : "First contribution"}
            </label>
            <input
              id="tsp-start"
              type="date"
              value={draft.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
              className={inputClass}
            />
          </div>
          {!once && (
            <div>
              <label htmlFor="tsp-end" className="block font-medium">
                Last contribution (optional)
              </label>
              <input
                id="tsp-end"
                type="date"
                value={draft.endDate}
                onChange={(e) => set({ endDate: e.target.value })}
                className={inputClass}
              />
            </div>
          )}
          {monthly && (
            <div>
              <label htmlFor="tsp-day" className="block font-medium">
                {draft.frequency === "semimonthly" ? "First day of the month" : "Day of the month"}
              </label>
              <input
                id="tsp-day"
                inputMode="numeric"
                value={draft.dayOfMonth}
                placeholder="same as the first date (or -1 for the last day)"
                onChange={(e) => set({ dayOfMonth: e.target.value })}
                className={inputClass}
              />
            </div>
          )}
          {draft.frequency === "semimonthly" && (
            <div>
              <label htmlFor="tsp-day2" className="block font-medium">
                Second day of the month
              </label>
              <input
                id="tsp-day2"
                inputMode="numeric"
                value={draft.secondDay}
                placeholder="14 days after the first (or -1 for the last day)"
                onChange={(e) => set({ secondDay: e.target.value })}
                className={inputClass}
              />
            </div>
          )}
        </div>

        <fieldset className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <legend className="px-1 font-medium">Employer contributions</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="tsp-match" className="block font-medium">
                Employer adds
              </label>
              <Select
                id="tsp-match"
                value={draft.matchPlan}
                onChange={(e) =>
                  set({ matchPlan: e.target.value as ContributionDraft["matchPlan"] })
                }
                className={inputClass}
              >
                <option value="">Nothing</option>
                <option value="fers">Federal agency (FERS): 1% automatic + up to 4% match</option>
                <option value="custom">My employer&apos;s own match (401(k) and others)</option>
              </Select>
            </div>
            {draft.matchPlan !== "" && (
              <div>
                <label htmlFor="tsp-pay" className="block font-medium">
                  {once ? "Gross pay it comes out of" : "Gross pay for each contribution"}
                </label>
                <input
                  id="tsp-pay"
                  inputMode="decimal"
                  value={draft.pay}
                  placeholder="4000.00"
                  onChange={(e) => set({ pay: e.target.value })}
                  className={inputClass}
                />
              </div>
            )}
            {draft.matchPlan === "custom" && (
              <>
                <div>
                  <label htmlFor="tsp-match-pct" className="block font-medium">
                    Matches this % of what you put in
                  </label>
                  <input
                    id="tsp-match-pct"
                    inputMode="decimal"
                    value={draft.matchPercent}
                    placeholder="100"
                    onChange={(e) => set({ matchPercent: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="tsp-match-cap" className="block font-medium">
                    Up to this % of pay
                  </label>
                  <input
                    id="tsp-match-cap"
                    inputMode="decimal"
                    value={draft.matchUpTo}
                    placeholder="6"
                    onChange={(e) => set({ matchUpTo: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="tsp-auto" className="block font-medium">
                    Plus this % of pay, whatever you put in
                  </label>
                  <input
                    id="tsp-auto"
                    inputMode="decimal"
                    value={draft.autoPercent}
                    placeholder="0"
                    onChange={(e) => set({ autoPercent: e.target.value })}
                    className={inputClass}
                  />
                </div>
              </>
            )}
          </div>
          {draft.matchPlan === "fers" && (
            <p className="mt-2 text-xs text-slate-500">
              The agency puts in 1% of pay always, then matches the first 3% of pay you put in
              dollar for dollar and the next 2% at 50 cents on the dollar. Put in 5% to get the full
              5%.
            </p>
          )}
          {draft.matchPlan === "custom" && (
            <p className="mt-2 text-xs text-slate-500">
              For example, &quot;50% up to 6% of pay&quot; matches half of what you put in, but
              never more than 6% of pay.
            </p>
          )}
        </fieldset>

        <div className="rounded-md bg-slate-100 p-3 text-xs dark:bg-slate-800">
          {employerMinor > 0 && ownMinor !== null && (
            <div className="mb-1">
              {formatMinor(ownMinor, "USD")} from you + {formatMinor(employerMinor, "USD")} from
              your employer ={" "}
              <span className="font-medium">{formatMinor(amountMinor!, "USD")}</span>
            </div>
          )}
          <div className="font-medium">
            {once ? "It buys" : "Each contribution buys"}, at the newest prices:
          </div>
          <ul className="mt-1 space-y-0.5">
            {settings.allocations.map((a) => {
              const price = settings.prices.find((p) => p.symbol === a.symbol)?.price ?? null;
              const units =
                amountMinor === null ? null : estimateUnits(amountMinor, a.percent, price);
              return (
                <li key={a.symbol}>
                  {a.name}: {a.percent}%
                  {amountMinor !== null &&
                    ` = ${formatMinor(Math.round((amountMinor * a.percent) / 100), "USD")}`}
                  {units !== null
                    ? ` ≈ ${formatUnits(units)} units`
                    : price === null
                      ? " (no price yet)"
                      : ""}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-slate-500">
            {once
              ? "The real amount is worked out on that day, at that day's price. A date in the past is applied straight away."
              : "The real amount is worked out on each day it is due, at that day's price."}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Saving..." : existing ? "Save" : "Add contribution"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
