import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

interface Period {
  start: string;
  end: string;
  due: string | null;
  current: boolean;
  chargesMinor: number;
  paymentsMinor: number;
  creditsMinor: number;
  netMinor: number;
  categories: Array<{ name: string; color: string | null; spendingMinor: number }>;
}

const money = (n: number) => formatMinor(n, "USD");

/** A credit card's open statement (or its last one): charges, payments, due date, top categories. */
export default defineWidget({
  id: "card-statement",
  title: "Credit card statement",
  description:
    "A credit card's open statement period (or the last closed one): charges, payments, credits, due date and top categories.",
  group: "Accounts",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
  order: 460,
  defaultConfig: { accountId: "", which: "open" },
  configFields: [
    {
      key: "accountId",
      label: "Credit card",
      type: "account",
      accountType: "credit",
      allLabel: "Choose a card",
      help: "Its statement closing day is set under Accounts → Statements.",
    },
    {
      key: "which",
      label: "Statement",
      type: "select",
      options: [
        { value: "open", label: "The open one (so far)" },
        { value: "last", label: "The last closed one" },
      ],
    },
  ],
  Component: function CardStatement({ config }) {
    const data = useApi<{ closingDay: number | null; periods: Period[] }>(
      config.accountId ? `/accounts/${config.accountId}/statements?count=2` : null,
    );
    if (!config.accountId) {
      return (
        <p className="text-sm text-slate-500">
          Choose a credit card in this widget&apos;s settings.
        </p>
      );
    }
    const p = data.data?.periods[config.which === "last" ? 1 : 0];
    return (
      <WidgetState
        loading={data.loading}
        error={data.error}
        empty={data.data !== null && data.data.closingDay === null}
        emptyText="Set this card's statement closing day under Accounts → Statements."
      >
        {p && (
          <div className="flex h-full flex-col gap-3 text-sm">
            <div className="text-xs text-slate-500">
              {formatDay(p.start)} – {formatDay(p.end)}
              {p.current ? " (open)" : ""}
              {p.due ? ` · due ${formatDay(p.due)}` : ""}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Charges" value={money(p.chargesMinor)} />
              <Stat label="Payments" value={money(p.paymentsMinor)} tone="good" />
              <Stat label="Credits" value={money(p.creditsMinor)} />
              <Stat
                label="Balance change"
                value={`${p.netMinor > 0 ? "+" : ""}${money(p.netMinor)}`}
              />
            </div>
            <ul className="space-y-1 text-xs">
              {p.categories.slice(0, 5).map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color ?? "#64748b" }}
                    />
                    <span className="truncate">{c.name}</span>
                  </span>
                  <span className="tabular-nums">{money(c.spendingMinor)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </WidgetState>
    );
  },
});
