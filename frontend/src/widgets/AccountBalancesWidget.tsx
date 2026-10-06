import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import type { Account } from "../types/api";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const TYPE_ORDER = ["depository", "credit", "investment", "loan"];
const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit: "Credit cards",
  investment: "Investments",
  loan: "Loans",
};

export default defineWidget({
  id: "account-balances",
  title: "Account balances",
  description: "Every account with its current balance, grouped by type or institution.",
  group: "Accounts",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 20,
  defaultConfig: { grouping: "type" },
  configFields: [
    {
      key: "grouping",
      label: "Group accounts by",
      type: "select",
      options: [
        { value: "type", label: "Type (cash, credit, ...)" },
        { value: "institution", label: "Institution" },
      ],
    },
  ],
  Component: function AccountBalances({ config }) {
    const { data, error, loading } = useApi<Account[]>("/accounts");
    const byInstitution = config.grouping === "institution";

    const groups = new Map<string, Account[]>();
    for (const account of data ?? []) {
      const key = byInstitution
        ? (account.institutionName ?? "Manual accounts")
        : (TYPE_LABEL[account.type] ?? "Other");
      groups.set(key, [...(groups.get(key) ?? []), account]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => {
      if (byInstitution) return a.localeCompare(b);
      const rank = (label: string) => {
        const i = TYPE_ORDER.findIndex((t) => TYPE_LABEL[t] === label);
        return i === -1 ? 99 : i;
      };
      return rank(a) - rank(b);
    });

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.length === 0}
        emptyText="No accounts yet. Connect one on the Accounts page."
      >
        <div className="space-y-3">
          {ordered.map(([group, accounts]) => (
            <section key={group}>
              <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                {group}
              </h3>
              <ul className="mt-1 space-y-1">
                {accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color ?? "#94a3b8" }}
                      />
                      <span className="truncate">{a.name}</span>
                      {a.mask && <span className="text-xs text-slate-500">••{a.mask}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatMinor(a.currentBalanceMinor, a.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </WidgetState>
    );
  },
});
