import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Account, Transaction } from "../../types/api";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { AmountCell } from "../transactions/TransactionCells";

interface Period {
  start: string;
  end: string;
  due: string | null;
  current: boolean;
  chargesMinor: number;
  paymentsMinor: number;
  creditsMinor: number;
  netMinor: number;
  count: number;
  categories: Array<{
    id: number | null;
    name: string;
    color: string | null;
    spendingMinor: number;
  }>;
  merchants: Array<{ name: string; spendingMinor: number; count: number }>;
}

interface Statements {
  accountId: number;
  closingDay: number | null;
  dueDay: number | null;
  periods: Period[];
}

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** "the 1st", "the 22nd", ..., and "the last day" for 31 (every month has one). */
export function dayOfMonth(n: number): string {
  if (n >= 31) return "the last day";
  const teen = n >= 11 && n <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `the ${n}${suffix}`;
}
const ordinal = dayOfMonth;

/**
 * A credit card's statements: set the day its statement closes (and payment is due), then see each
 * statement period, the open one first, with what was charged, paid and credited, spending by
 * category and merchant, and every transaction posted in it.
 */
export function StatementsDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const navigate = useNavigate();
  const data = useApi<Statements>(`/accounts/${account.id}/statements?count=12`);
  const [closing, setClosing] = useState("");
  const [due, setDue] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = (minor: number) => formatMinor(minor, account.currency || "USD");

  useEffect(() => {
    if (!data.data) return;
    setClosing(data.data.closingDay === null ? "" : String(data.data.closingDay));
    setDue(data.data.dueDay === null ? "" : String(data.data.dueDay));
  }, [data.data]);

  const saved = data.data;
  const changed =
    saved !== null &&
    (closing !== (saved.closingDay === null ? "" : String(saved.closingDay)) ||
      due !== (saved.dueDay === null ? "" : String(saved.dueDay)));

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/accounts/${account.id}/statement-settings`, {
        method: "PUT",
        body: JSON.stringify({
          closingDay: closing === "" ? null : Number(closing),
          dueDay: closing === "" || due === "" ? null : Number(due),
        }),
      });
      setSelected(0);
      data.reload();
      announceDataChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save the statement days."));
    } finally {
      setBusy(false);
    }
  }

  const periods = saved?.periods ?? [];
  const period = periods[selected] ?? null;
  const most = Math.max(1, ...periods.map((p) => p.chargesMinor));

  return (
    <Modal title={`${account.name}: statements`} onClose={onClose} wide="full" dismissible>
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block font-medium">Statement closes on</span>
            <Select
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              className="mt-1 w-48 rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
            >
              <option value="">Not set</option>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {`${ordinal(d)} of the month`}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="block font-medium">Payment due on</span>
            <Select
              value={due}
              disabled={closing === ""}
              onChange={(e) => setDue(e.target.value)}
              className="mt-1 w-48 rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900"
            >
              <option value="">Not set</option>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {`${ordinal(d)}, after closing`}
                </option>
              ))}
            </Select>
          </label>
          <button
            type="button"
            disabled={!changed || busy}
            onClick={() => void save()}
            className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
          <p className="basis-full text-xs text-slate-500">
            Find these on a paper or PDF statement (&ldquo;closing date&rdquo; and &ldquo;payment
            due date&rdquo;). A day later than a month has means its last day. Transactions count in
            the period they posted in, as on the statement.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {data.error && <p className="text-red-600">{data.error}</p>}

        {saved && saved.closingDay === null && (
          <p className="rounded-md bg-slate-50 p-3 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            Set the day the statement closes to see spending per statement.
          </p>
        )}

        {periods.length > 0 && (
          <>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {periods.map((p, i) => (
                <button
                  key={p.start}
                  type="button"
                  aria-pressed={i === selected}
                  onClick={() => setSelected(i)}
                  className={`flex w-32 shrink-0 flex-col justify-end rounded-md border px-2 pt-2 pb-1.5 text-left ${
                    i === selected
                      ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                      : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  }`}
                >
                  <span className="mb-1 flex h-12 items-end">
                    <span
                      className={`w-full rounded-sm ${p.current ? "bg-blue-300" : "bg-blue-500"}`}
                      style={{ height: `${Math.max(4, (p.chargesMinor / most) * 100)}%` }}
                    />
                  </span>
                  <span className="text-xs font-medium">
                    {p.current ? "Open now" : `Closed ${formatDay(p.end)}`}
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {money(p.chargesMinor)}
                  </span>
                </button>
              ))}
            </div>

            {period && (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold">
                      {formatDay(period.start)} – {formatDay(period.end)}
                      {period.current ? " (open)" : ""}
                    </h3>
                    {period.due && (
                      <p className="text-xs text-slate-500">Payment due {formatDay(period.due)}</p>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-2">
                    <Stat label="Charges" value={money(period.chargesMinor)} />
                    <Stat label="Payments" value={money(period.paymentsMinor)} />
                    <Stat label="Refunds and credits" value={money(period.creditsMinor)} />
                    <Stat
                      label="Balance change"
                      value={`${period.netMinor > 0 ? "+" : ""}${money(period.netMinor)}`}
                    />
                  </dl>
                  <div>
                    <h4 className="mb-1 font-medium">Spending by category</h4>
                    {period.categories.length === 0 && (
                      <p className="text-xs text-slate-500">Nothing charged in this period.</p>
                    )}
                    <ul className="space-y-1.5">
                      {period.categories.map((c) => {
                        const top = Math.max(1, period.categories[0]!.spendingMinor);
                        return (
                          <li key={c.name}>
                            <div className="flex justify-between gap-2 text-xs">
                              <span className="truncate">{c.name}</span>
                              <span className="tabular-nums">{money(c.spendingMinor)}</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-700">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(0, (c.spendingMinor / top) * 100)}%`,
                                  backgroundColor: c.color ?? "#64748b",
                                }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {period.merchants.length > 0 && (
                    <div>
                      <h4 className="mb-1 font-medium">Top merchants</h4>
                      <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                        {period.merchants.map((m) => (
                          <li key={m.name} className="flex justify-between gap-2 py-1">
                            <span className="truncate">
                              {m.name}
                              {m.count > 1 ? ` · ${m.count}×` : ""}
                            </span>
                            <span className="tabular-nums">{money(m.spendingMinor)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <PeriodTransactions
                  account={account}
                  period={period}
                  onOpen={(t) => {
                    onClose();
                    navigate(`/transactions?focus=${t.id}&account=${t.accountId}`);
                  }}
                  onOpenAll={() => {
                    onClose();
                    navigate(
                      `/transactions?account=${account.id}&from=${period.start}&to=${period.end}&dateBasis=posted`,
                    );
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** A "Statements" button for a credit card, opening its statements. */
export function StatementsButton({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  if (account.type !== "credit") return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
      >
        Statements
        {account.statementClosingDay ? ` (closes ${dayOfMonth(account.statementClosingDay)})` : ""}
      </button>
      {open && <StatementsDialog account={account} onClose={() => setOpen(false)} />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** Every transaction posted in the period, newest first. */
function PeriodTransactions({
  account,
  period,
  onOpen,
  onOpenAll,
}: {
  account: Account;
  period: Period;
  onOpen: (t: Transaction) => void;
  onOpenAll: () => void;
}) {
  const list = useApi<{ items: Transaction[]; total: number }>(
    `/transactions?accountId=${account.id}&from=${period.start}&to=${period.end}&dateBasis=posted&pageSize=200&sort=date_desc`,
  );
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="font-medium">Transactions{list.data ? ` (${list.data.total})` : ""}</h4>
        <button
          type="button"
          onClick={onOpenAll}
          className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
        >
          Open in Transactions
        </button>
      </div>
      {list.error && <p className="text-red-600">{list.error}</p>}
      <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {(list.data?.items ?? []).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onOpen(t)}
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <span className="min-w-0">
                <span className="block truncate">{t.merchant}</span>
                <span className="block text-xs text-slate-500">
                  {t.pending ? "Pending" : `Posted ${formatDay(t.date)}`}
                  {t.category ? ` · ${t.category.name}` : ""}
                </span>
              </span>
              <AmountCell t={t} />
            </button>
          </li>
        ))}
        {list.data && list.data.items.length === 0 && (
          <li className="px-3 py-3 text-xs text-slate-500">Nothing posted in this period yet.</li>
        )}
      </ul>
    </div>
  );
}
