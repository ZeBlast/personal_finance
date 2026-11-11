import { useState } from "react";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";

/** One card's statement that closes in a month. */
export interface CardInMonth {
  accountId: number;
  start: string;
  end: string;
  due: string | null;
  current: boolean;
  chargesMinor: number;
  paymentsMinor: number;
  creditsMinor: number;
  newBalanceMinor: number | null;
  count: number;
}

export interface CombinedMonth {
  /** `YYYY-MM`: the month these statements close in. */
  month: string;
  open: boolean;
  chargesMinor: number;
  paymentsMinor: number;
  creditsMinor: number;
  newBalanceMinor: number | null;
  count: number;
  cards: CardInMonth[];
  categories: Array<{
    id: number | null;
    name: string;
    color: string | null;
    spendingMinor: number;
  }>;
  merchants: Array<{ name: string; spendingMinor: number; count: number }>;
}

export interface Combined {
  cards: Array<{ accountId: number; name: string; color: string | null; currency: string }>;
  withoutClosingDay: Array<{ accountId: number; name: string }>;
  months: CombinedMonth[];
}

/** Colors for cards that have none of their own, told apart in light and dark. */
const FALLBACK = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d"];

/** Each card's color: its own, or one of a fixed few by its place in the list. Pure. */
export function cardColors(cards: Combined["cards"]): Map<number, string> {
  return new Map(cards.map((c, i) => [c.accountId, c.color ?? FALLBACK[i % FALLBACK.length]!]));
}

/** "2026-11" as "Nov 2026". */
export function monthLabel(month: string, long = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, {
    year: "numeric",
    month: long ? "long" : "short",
  });
}

/**
 * Across cards: what the latest closed statements came to, and what the open ones have reached.
 * A card without a known balance counts by its charges for the open one, and not at all for the
 * closed one (null when no card's is known). Pure.
 */
export function combinedTotals(data: Combined): {
  closedMinor: number | null;
  openMinor: number;
} {
  let closedMinor: number | null = null;
  let openMinor = 0;
  for (const card of data.cards) {
    // Months are newest first, so the first closed statement met is the card's latest.
    const mine = data.months.flatMap((m) => m.cards.filter((c) => c.accountId === card.accountId));
    const open = mine.find((c) => c.current);
    const closed = mine.find((c) => !c.current);
    if (open) openMinor += open.newBalanceMinor ?? open.chargesMinor;
    if (closed && closed.newBalanceMinor !== null) {
      closedMinor = (closedMinor ?? 0) + closed.newBalanceMinor;
    }
  }
  return { closedMinor, openMinor };
}

/**
 * Every card's statements together. Cards close on different days, so statements are grouped by
 * the month they close in: pick a month to see what all cards charged in it, each card's share
 * and dates, and spending by category and merchant across them. `onOpenCard` opens one card's
 * statement in full.
 */
export function CombinedStatements({
  data,
  onOpenCard,
}: {
  data: Combined;
  onOpenCard: (accountId: number, end: string) => void;
}) {
  // The newest month whose statements have all closed is the one most worth reading first.
  const firstClosed = data.months.findIndex((m) => !m.open);
  const [selected, setSelected] = useState(firstClosed === -1 ? 0 : firstClosed);
  const colors = cardColors(data.cards);
  const nameOf = new Map(data.cards.map((c) => [c.accountId, c.name]));
  const money = (minor: number) => formatMinor(minor, data.cards[0]?.currency || "USD");
  const most = Math.max(1, ...data.months.map((m) => m.chargesMinor));
  const month = data.months[selected] ?? null;

  return (
    <div className="space-y-5 text-sm">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Cards close on different days, so each month here is every card&apos;s statement that closes
        in that month.
        {data.withoutClosingDay.length > 0 &&
          ` Not counted until a closing day is set: ${data.withoutClosingDay.map((c) => c.name).join(", ")}.`}
      </p>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Cards">
        {data.cards.map((c) => (
          <li key={c.accountId} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: colors.get(c.accountId) }}
            />
            {c.name}
          </li>
        ))}
      </ul>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {data.months.map((m, i) => (
          <button
            key={m.month}
            type="button"
            aria-pressed={i === selected}
            onClick={() => setSelected(i)}
            title={m.cards
              .map((c) => `${nameOf.get(c.accountId) ?? "Card"}: ${money(c.chargesMinor)}`)
              .join("\n")}
            className={`flex w-28 shrink-0 flex-col justify-end rounded-md border px-2 pt-2 pb-1.5 text-left ${
              i === selected
                ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            }`}
          >
            <span className="mb-1 flex h-14 items-end">
              <span
                className={`flex w-full flex-col-reverse gap-px overflow-hidden rounded-sm ${m.open ? "opacity-60" : ""}`}
                style={{ height: `${Math.max(4, (m.chargesMinor / most) * 100)}%` }}
              >
                {m.cards
                  .filter((c) => c.chargesMinor > 0)
                  .map((c) => (
                    <span
                      key={c.accountId}
                      style={{
                        flexGrow: c.chargesMinor,
                        flexBasis: 0,
                        backgroundColor: colors.get(c.accountId),
                      }}
                    />
                  ))}
                {m.chargesMinor === 0 && <span className="grow bg-slate-200 dark:bg-slate-700" />}
              </span>
            </span>
            <span className="text-xs font-medium">
              {monthLabel(m.month)}
              {m.open ? " · open" : ""}
            </span>
            <span
              className="text-xs text-slate-600 tabular-nums dark:text-slate-300"
              title="Charges"
            >
              {money(m.chargesMinor)}
            </span>
          </button>
        ))}
      </div>

      {month && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">
                Statements closing in {monthLabel(month.month, true)}
              </h3>
              {month.cards.length < data.cards.length && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {month.cards.length} of {data.cards.length} cards so far: the others&apos; open
                  statements close a month earlier.
                </p>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
              <Stat label="Charges" value={money(month.chargesMinor)} />
              <Stat label="Payments" value={money(month.paymentsMinor)} />
              <Stat label="Refunds and credits" value={money(month.creditsMinor)} />
              <Stat
                label={month.open ? "Balances so far" : "New balances"}
                value={month.newBalanceMinor === null ? "Not known" : money(month.newBalanceMinor)}
              />
            </dl>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Card</th>
                    <th className="py-1 pr-3 font-medium">Statement</th>
                    <th className="py-1 pr-3 text-right font-medium">Charges</th>
                    <th className="py-1 pr-3 text-right font-medium">Share</th>
                    <th className="py-1 pr-3 text-right font-medium whitespace-nowrap">
                      New balance
                    </th>
                    <th className="py-1 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {month.cards.map((c) => {
                    const share =
                      month.chargesMinor > 0 ? (c.chargesMinor / month.chargesMinor) * 100 : 0;
                    return (
                      <tr
                        key={c.accountId}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="py-1.5 pr-3">
                          <button
                            type="button"
                            onClick={() => onOpenCard(c.accountId, c.end)}
                            title="Open this statement in full"
                            className="flex items-center gap-2 text-left text-blue-700 hover:underline dark:text-blue-300"
                          >
                            <span
                              aria-hidden="true"
                              className="h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ backgroundColor: colors.get(c.accountId) }}
                            />
                            {nameOf.get(c.accountId) ?? "Card"}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3 text-xs whitespace-nowrap text-slate-600 dark:text-slate-300">
                          {formatDay(c.start)} – {formatDay(c.end)}
                          {c.current ? " (open)" : ""}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {money(c.chargesMinor)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-xs text-slate-600 tabular-nums dark:text-slate-300">
                          {Math.round(share)}%
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {c.newBalanceMinor === null ? "" : money(c.newBalanceMinor)}
                        </td>
                        <td className="py-1.5 whitespace-nowrap">
                          {c.due ? formatDay(c.due) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {month.cards.length > 1 && (
                  <tfoot>
                    <tr className="border-t border-slate-300 font-medium dark:border-slate-600">
                      <td className="py-1.5 pr-3" colSpan={2}>
                        Together
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {money(month.chargesMinor)}
                      </td>
                      <td />
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {month.newBalanceMinor === null ? "" : money(month.newBalanceMinor)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h4 className="mb-1 font-medium">Spending by category, all cards</h4>
              {month.categories.length === 0 && (
                <p className="text-xs text-slate-500">Nothing charged in these statements.</p>
              )}
              <ul className="space-y-1.5">
                {month.categories.map((c) => {
                  const top = Math.max(1, month.categories[0]!.spendingMinor);
                  return (
                    <li key={c.id ?? "none"}>
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
            {month.merchants.length > 0 && (
              <div>
                <h4 className="mb-1 font-medium">Top merchants, all cards</h4>
                <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                  {month.merchants.map((m) => (
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
        </div>
      )}
    </div>
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
