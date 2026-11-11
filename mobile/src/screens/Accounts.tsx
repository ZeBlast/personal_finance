import { useState } from "react";
import { formatMinor } from "../../../frontend/src/lib/money";
import type { Account } from "../../../frontend/src/types/api";
import { accounts, dayLabel, groupAccounts, transactions } from "../lib/data";
import type { Snapshot } from "../lib/snapshot";
import { Button, Card, Page } from "./ui";

const PAGE = 100;

export function AccountsScreen({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState<Account | null>(null);
  if (open)
    return <AccountDetail snapshot={snapshot} account={open} onBack={() => setOpen(null)} />;

  const groups = groupAccounts(accounts(snapshot));
  return (
    <Page title="Accounts">
      {groups.length === 0 && <p>No accounts yet.</p>}
      {groups.map((g) => (
        <Card key={g.label} title={g.label}>
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {g.accounts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="flex min-h-12 w-full items-center justify-between gap-2 py-2 text-left"
                  onClick={() => setOpen(a)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{a.name}</span>
                    <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
                      {[a.institutionName, a.mask ? `...${a.mask}` : null]
                        .filter(Boolean)
                        .join(" ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatMinor(a.currentBalanceMinor, a.currency)}
                    {a.type === "credit" && a.creditLimitMinor !== null && (
                      <span className="block text-sm text-slate-500 dark:text-slate-400">
                        of {formatMinor(a.creditLimitMinor, a.currency)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </Page>
  );
}

function AccountDetail({
  snapshot,
  account,
  onBack,
}: {
  snapshot: Snapshot;
  account: Account;
  onBack: () => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const list = transactions(snapshot).filter((t) => t.accountId === account.id);

  return (
    <Page title={account.name}>
      <Button onClick={onBack}>Back to accounts</Button>
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Balance</p>
        <p className="text-2xl font-semibold tabular-nums">
          {formatMinor(account.currentBalanceMinor, account.currency)}
        </p>
        {account.availableBalanceMinor !== null &&
          account.availableBalanceMinor !== account.currentBalanceMinor && (
            <p className="text-sm">
              Available {formatMinor(account.availableBalanceMinor, account.currency)}
            </p>
          )}
      </Card>
      <Card title="Activity">
        {list.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No transactions in the last 13 months.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {list.slice(0, shown).map((t) => (
              <li key={t.id} className="flex justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{t.merchant}</span>
                  <span className="block truncate text-slate-500 dark:text-slate-400">
                    {dayLabel(t.date)}
                    {t.category ? ` · ${t.category.name}` : ""}
                    {t.pending ? " · pending" : ""}
                  </span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "text-green-700 dark:text-green-400" : ""}`}
                >
                  {t.amountMinor < 0 ? "+" : "-"}
                  {formatMinor(Math.abs(t.amountMinor), t.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {list.length > shown && <Button onClick={() => setShown(shown + PAGE)}>Show more</Button>}
      </Card>
    </Page>
  );
}
