import { AlertTriangle, Check, CircleDot, Clock, Minus } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { StatementsPanel } from "../components/accounts/StatementsDialog";
import { Loading } from "../components/common/Loading";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { Account } from "../types/api";
import type { BillStatus, CardBill } from "../types/planning";

const STATUS: Record<BillStatus, { word: string; Icon: typeof Check; className: string }> = {
  paid: { word: "Paid", Icon: Check, className: "text-green-700 dark:text-green-400" },
  partial: {
    word: "Partly paid",
    Icon: CircleDot,
    className: "text-amber-800 dark:text-amber-400",
  },
  due: { word: "Due", Icon: Clock, className: "text-slate-700 dark:text-slate-200" },
  overdue: { word: "Overdue", Icon: AlertTriangle, className: "text-red-700 dark:text-red-400" },
  nothing_due: {
    word: "Nothing due",
    Icon: Minus,
    className: "text-slate-600 dark:text-slate-300",
  },
};

/** The two latest statement periods of a card, as the statements call gives them, newest first. */
interface RecentPeriods {
  periods: Array<{
    end: string;
    due: string | null;
    chargesMinor: number;
    newBalanceMinor: number | null;
  }>;
}

/** What is left to pay across cards, and the soonest date one of them is due. Pure. */
export function statementTotals(bills: CardBill[]): {
  remainingMinor: number;
  nextDue: string | null;
  overdue: number;
} {
  const open = bills
    .map((b) => b.statement)
    .filter((s): s is NonNullable<CardBill["statement"]> => s !== null)
    .filter((s) => s.remainingMinor > 0);
  return {
    remainingMinor: open.reduce((sum, s) => sum + s.remainingMinor, 0),
    nextDue: open.map((s) => s.dueOn).sort()[0] ?? null,
    overdue: open.filter((s) => s.status === "overdue").length,
  };
}

/** Which card to show: the one asked for if it is still a card here, otherwise the first. Pure. */
export function chosenCard(cards: Account[], asked: string | null): Account | null {
  return cards.find((c) => String(c.id) === asked) ?? cards[0] ?? null;
}

/**
 * A card's latest closed statement. A card's days can be set in either of two places: Card bills,
 * which also tracks what has been paid, or its Statements, which gives the figures but not that.
 */
function CardRow({
  card,
  bill,
  selected,
  onSelect,
}: {
  card: Account;
  bill: CardBill | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const recent = useApi<RecentPeriods>(`/accounts/${card.id}/statements?count=2`);
  const money = (minor: number) => formatMinor(minor, card.currency || "USD");
  const s = bill?.statement ?? null;
  const look = s ? STATUS[s.status] : null;
  const open = recent.data?.periods[0] ?? null;
  const closed = recent.data?.periods[1] ?? null;
  const openSoFar = bill?.next?.balanceSoFarMinor ?? open?.newBalanceMinor ?? open?.chargesMinor;

  return (
    // The whole row picks the card; the name stays a button so the keyboard can reach it. Links and
    // buttons inside the row keep their own job.
    <tr
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a, button")) onSelect();
      }}
      className={`cursor-pointer border-t border-slate-100 dark:border-slate-800 ${selected ? "bg-blue-50 dark:bg-blue-950/40" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"}`}
    >
      <td className="py-1.5 pr-3 pl-2">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className={`flex items-center gap-2 text-left hover:underline ${selected ? "font-semibold" : ""}`}
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: card.color ?? "#94a3b8" }}
          />
          {card.name}
        </button>
      </td>
      {s && look ? (
        <>
          <td className="py-1.5 pr-3 whitespace-nowrap">{formatDay(s.closedOn)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{money(s.balanceMinor)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{money(s.remainingMinor)}</td>
          <td className="py-1.5 pr-3 whitespace-nowrap">{formatDay(s.dueOn)}</td>
          <td className="py-1.5 pr-3 whitespace-nowrap">
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${look.className}`}
            >
              <look.Icon aria-hidden="true" className="h-3.5 w-3.5" />
              {look.word}
            </span>
          </td>
        </>
      ) : closed ? (
        <>
          <td className="py-1.5 pr-3 whitespace-nowrap">{formatDay(closed.end)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">
            {closed.newBalanceMinor === null ? "" : money(closed.newBalanceMinor)}
          </td>
          <td className="py-1.5 pr-3 text-right text-xs text-slate-600 dark:text-slate-300">
            Not tracked
          </td>
          <td className="py-1.5 pr-3 whitespace-nowrap">
            {closed.due ? formatDay(closed.due) : ""}
          </td>
          <td className="py-1.5 pr-3 whitespace-nowrap">
            <Link
              to="/planning/bills"
              title="Card bills, under Planning, tracks what has been paid and adds the bill to your forecast."
              className="text-xs text-blue-700 underline dark:text-blue-300"
            >
              Track in Planning
            </Link>
          </td>
        </>
      ) : (
        <td colSpan={5} className="py-1.5 pr-3 text-xs text-slate-600 dark:text-slate-300">
          {recent.data || !recent.loading ? "Set the closing day below to see statements" : ""}
        </td>
      )}
      <td className="py-1.5 pr-2 text-right tabular-nums">
        {openSoFar === undefined || openSoFar === null ? "" : money(openSoFar)}
      </td>
    </tr>
  );
}

/**
 * Every credit card's latest statement side by side, and one card's statements in full below: each
 * period's charges, payments and credits, spending by category and merchant, and its transactions.
 */
export function CardStatementsPage() {
  const accounts = useApi<Account[]>("/accounts");
  const bills = useApi<CardBill[]>("/bills");
  const [params, setParams] = useSearchParams();

  const cards = (accounts.data ?? []).filter((a) => a.type === "credit" && !a.hidden);
  const chosen = chosenCard(cards, params.get("card"));
  const billOf = (id: number) => bills.data?.find((b) => b.accountId === id) ?? null;
  const totals = statementTotals(cards.map((c) => billOf(c.id)).filter((b) => b !== null));
  const money = (minor: number) => formatMinor(minor, cards[0]?.currency || "USD");
  const error = accounts.error ?? bills.error;
  const anyTracked = cards.some((c) => billOf(c.id)?.statement);

  return (
    <section className="@container max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Card statements</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {cards.length === 0
            ? "Each credit card's statements, once you have a card."
            : !anyTracked
              ? "Each card's latest statement, and any card's statements in full below."
              : totals.remainingMinor > 0
                ? `${money(totals.remainingMinor)} left to pay on closed statements, next due ${formatDay(totals.nextDue!)}.${totals.overdue > 0 ? ` ${totals.overdue} overdue.` : ""}`
                : "Nothing left to pay on closed statements."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!accounts.data && accounts.loading && <Loading lines={6} />}

      {accounts.data && cards.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No credit cards yet.{" "}
          <Link to="/accounts" className="text-blue-600 underline dark:text-blue-400">
            Add one under Accounts
          </Link>
          .
        </p>
      )}

      {cards.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 pl-2 font-medium">Card</th>
                <th className="py-1 pr-3 font-medium">Last closed</th>
                <th className="py-1 pr-3 text-right font-medium">Balance</th>
                <th className="py-1 pr-3 text-right font-medium">Left to pay</th>
                <th className="py-1 pr-3 font-medium">Due</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-2 text-right font-medium whitespace-nowrap">Open so far</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  bill={billOf(card.id)}
                  selected={chosen?.id === card.id}
                  onSelect={() => setParams({ card: String(card.id) }, { replace: true })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chosen && (
        <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
          <h2 className="mb-3 text-lg font-semibold">{chosen.name}</h2>
          {/* Keyed by card, so one card's chosen period does not carry over to the next. */}
          <StatementsPanel key={chosen.id} account={chosen} />
        </div>
      )}
    </section>
  );
}
