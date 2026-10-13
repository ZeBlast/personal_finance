import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import type { Account } from "../types/api";
import { institutionField, periodField } from "./fields";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const money = (n: number | null) => formatMinor(n, "USD");

/**
 * One bank (or the accounts kept by hand) at a glance: each of its accounts with its balance,
 * what they hold and owe together, and what went in and out of them over the period.
 */
export default defineWidget({
  id: "bank-summary",
  title: "Bank summary",
  description:
    "One bank at a glance: its accounts and balances, what they hold and owe together, and money in and out over a period.",
  group: "Accounts",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
  order: 440,
  defaultConfig: { institution: "", period: "this-month" },
  configFields: [
    { ...institutionField, help: "Choose the bank to show (or the accounts kept by hand)." },
    periodField,
  ],
  Component: function BankSummary({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const accounts = useApi<Account[]>("/accounts");
    const bank = config.institution;
    const mine = (accounts.data ?? []).filter((a) =>
      bank === "manual" ? a.isManual : a.institutionName === bank,
    );
    const totals = useApi<Summary>(
      bank
        ? summaryPath({ from: period.from, to: period.to, groupBy: "none", institution: bank })
        : null,
    );
    if (!bank) {
      return (
        <p className="text-sm text-slate-500">Choose a bank in this widget&apos;s settings.</p>
      );
    }
    const debt = (a: Account) => a.type === "credit" || a.type === "loan";
    const holds = mine
      .filter((a) => !debt(a))
      .reduce((n, a) => n + (a.currentBalanceMinor ?? 0), 0);
    const owes = mine.filter(debt).reduce((n, a) => n + (a.currentBalanceMinor ?? 0), 0);
    const t = totals.data?.totals;

    return (
      <WidgetState
        loading={accounts.loading || totals.loading}
        error={accounts.error ?? totals.error}
        empty={accounts.data !== null && mine.length === 0}
        emptyText="No accounts at this bank."
      >
        <div className="flex h-full flex-col gap-3 text-sm">
          <div className="font-medium">{bank === "manual" ? "Kept by hand" : bank}</div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Holds" value={money(holds)} />
            <Stat label="Owes" value={money(owes)} tone={owes > 0 ? "bad" : undefined} />
            <Stat label={`Spent ${period.label}`} value={money(t?.spendingMinor ?? 0)} />
            <Stat label="Money in" value={money(t?.incomeMinor ?? 0)} tone="good" />
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {mine.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: a.color ?? "#94a3b8" }}
                  />
                  <span className="truncate">{a.name}</span>
                </span>
                <span className="tabular-nums">{money(a.currentBalanceMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      </WidgetState>
    );
  },
});
