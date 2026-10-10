import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { Donut } from "../components/charts/Donut";
import { LineChart } from "../components/charts/LineChart";
import { colorAt } from "../components/charts/palette";
import { ConfirmDialog } from "../components/common/Modal";
import { CsvImportDialog } from "../components/investments/CsvImportDialog";
import { HoldingsEditor } from "../components/investments/HoldingsEditor";
import { ManualAccountDialog } from "../components/investments/ManualAccountDialog";
import {
  InvestmentTransactionDialog,
  SecurityDetailDialog,
} from "../components/investments/SecurityDetailDialog";
import { buttonClass, primaryClass } from "../components/investments/styles";
import { TransactionForm } from "../components/investments/TransactionForm";
import { TspAccountDialog } from "../components/investments/TspAccountDialog";
import { TspPanel } from "../components/investments/TspPanel";
import { TSP_SUBTYPE } from "../lib/tsp";
import { ConnectButton } from "../components/plaid/ConnectButton";
import { useApi } from "../hooks/useApi";
import { formatAxisMoney, formatMinor, formatQuantity } from "../lib/money";
import { announceDataChanged, announceSyncFinished } from "../lib/syncEvents";
import { formatDay, timeAgo } from "../lib/time";
import type {
  CostBasisSummary,
  HoldingRow,
  InvestmentTransactionRow,
  PortfolioAccount,
  PortfolioHistory,
  PortfolioOverview,
} from "../types/investments";

type Dialog =
  | "new-account"
  | "new-tsp"
  | "holdings"
  | "import-holdings"
  | "import-transactions"
  | "transaction"
  | "delete-account"
  | null;

const PAGE_SIZE = 50;

const TYPE_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  interest: "Interest",
  contribution: "Contribution",
  withdrawal: "Withdrawal",
  fee: "Fee",
  transfer: "Transfer",
  other: "Other",
};

const money = (n: number) => formatMinor(n, "USD");

function Gain({ basis }: { basis: CostBasisSummary | null }) {
  if (!basis) {
    return (
      <span className="text-slate-500">
        Gain unknown: no cost has been recorded for these holdings.
      </span>
    );
  }
  const tone =
    basis.gainMinor >= 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400";
  return (
    <span className="text-slate-600 dark:text-slate-300">
      {basis.complete ? "Gain" : `Gain on the ${money(basis.knownValueMinor)} with a known cost`}{" "}
      <span className={`font-medium ${tone}`}>
        {basis.gainMinor >= 0 ? "+" : "−"}
        {money(Math.abs(basis.gainMinor))}
      </span>
      {!basis.complete && " (other holdings have no cost recorded)"}
    </span>
  );
}

function AccountCard({
  account,
  selected,
  onSelect,
}: {
  account: PortfolioAccount;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`w-full rounded-md border p-3 text-left text-sm ${
          selected
            ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
            : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: account.color ?? "#94a3b8" }}
            />
            <span className="truncate font-medium">{account.name}</span>
          </span>
          <span className="shrink-0 font-medium tabular-nums">{money(account.valueMinor)}</span>
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {account.isManual ? "Entered by hand" : (account.institutionName ?? "Connected")}
          {account.officialName && account.isManual ? ` · ${account.officialName}` : ""}
          {" · "}
          {!account.isManual && account.holdingCount === 0 && account.valueMinor > 0
            ? "balance only (no holdings reported)"
            : `${account.holdingCount} holding${account.holdingCount === 1 ? "" : "s"}`}
          {account.updatedAt ? ` · updated ${timeAgo(account.updatedAt)}` : ""}
          {account.connectionStatus === "login_required" ? " · needs sign-in (see Accounts)" : ""}
        </div>
      </button>
    </li>
  );
}

export function InvestmentsPage() {
  const [accountId, setAccountId] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [deletingTransaction, setDeletingTransaction] = useState<InvestmentTransactionRow | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** A fund or stock whose full record is open, and an investment transaction likewise. */
  const [viewSecurity, setViewSecurity] = useState<{ id: number; title: string } | null>(null);
  const [viewTransaction, setViewTransaction] = useState<number | null>(null);

  const query = accountId ? `accountId=${accountId}` : "";
  const all = useApi<PortfolioOverview>("/investments/overview");
  const scopedOverview = useApi<PortfolioOverview>(
    accountId ? `/investments/overview?${query}` : null,
  );
  const overview = accountId ? scopedOverview.data : all.data;
  const holdings = useApi<HoldingRow[]>(`/investments/holdings${query ? `?${query}` : ""}`);
  const history = useApi<PortfolioHistory>(`/investments/history${query ? `?${query}` : ""}`);
  const activity = useApi<{ total: number; rows: InvestmentTransactionRow[] }>(
    `/investments/transactions?limit=${limit}${query ? `&${query}` : ""}`,
  );

  const accounts = all.data?.accounts ?? [];
  const selected = accounts.find((a) => String(a.id) === accountId) ?? null;
  const manualSelected = selected?.isManual ? selected : null;

  function reloadAll(): void {
    all.reload();
    scopedOverview.reload();
    holdings.reload();
    history.reload();
    activity.reload();
    announceDataChanged(); // dashboard investment widgets reload
  }

  function changed(text: string): void {
    setDialog(null);
    setNotice({ kind: "info", text });
    reloadAll();
  }

  async function connected(text: string, itemId: number): Promise<void> {
    setNotice({ kind: "info", text: `${text} Fetching its holdings...` });
    try {
      await api("/sync", { method: "POST", body: JSON.stringify({ itemId }) });
      setNotice({ kind: "info", text });
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Connected, but the first sync failed.") });
    } finally {
      announceSyncFinished();
    }
  }

  async function deleteAccount(): Promise<void> {
    if (!manualSelected) return;
    setBusy(true);
    try {
      await api(`/investments/accounts/${manualSelected.id}`, { method: "DELETE" });
      setAccountId("");
      changed(`Deleted ${manualSelected.name}.`);
    } catch (e) {
      setDialog(null);
      setNotice({ kind: "error", text: errorMessage(e, "Could not delete the account.") });
    } finally {
      setBusy(false);
    }
  }

  async function deleteTransaction(): Promise<void> {
    if (!deletingTransaction) return;
    setBusy(true);
    try {
      await api(`/investments/transactions/${deletingTransaction.id}`, { method: "DELETE" });
      changed("Deleted the transaction.");
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not delete the transaction.") });
    } finally {
      setDeletingTransaction(null);
      setBusy(false);
    }
  }

  const loadError = all.error;
  const noAccounts = all.data !== null && accounts.length === 0;
  const total = activity.data?.total ?? 0;
  const rows = activity.data?.rows ?? [];

  return (
    <section className="max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Investments</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Brokerage and retirement accounts, connected or kept by hand.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ConnectButton
            label="Connect a brokerage"
            kind="investments"
            onDone={(text, itemId) => void connected(text, itemId)}
            onError={(text) => setNotice({ kind: "error", text })}
          />
          <button type="button" className={buttonClass} onClick={() => setDialog("new-tsp")}>
            Add TSP account
          </button>
          <button type="button" className={primaryClass} onClick={() => setDialog("new-account")}>
            Add account by hand
          </button>
        </div>
      </div>

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
      {loadError && (
        <p role="alert" className="text-sm text-red-600">
          {loadError}
        </p>
      )}

      {noAccounts && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm dark:border-slate-600">
          <h2 className="text-base font-semibold">No investment accounts yet</h2>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            <strong>Connect a brokerage</strong> (such as Fidelity) to have its holdings fetched on
            each sync, or <strong>add an account by hand</strong> for something that cannot be
            connected, such as the Thrift Savings Plan. Hand-made accounts take typed-in holdings or
            a CSV file, and show up in the same charts as connected ones.
          </p>
        </div>
      )}

      {accounts.length > 0 && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Accounts</h2>
              {selected && (
                <button type="button" className={buttonClass} onClick={() => setAccountId("")}>
                  Show all accounts
                </button>
              )}
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  selected={String(a.id) === accountId}
                  onSelect={() => {
                    setAccountId(String(a.id) === accountId ? "" : String(a.id));
                    setLimit(PAGE_SIZE);
                  }}
                />
              ))}
            </ul>
          </div>

          {manualSelected && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 p-3 text-sm dark:bg-slate-800">
              <span className="mr-2 font-medium">{manualSelected.name}:</span>
              <button type="button" className={buttonClass} onClick={() => setDialog("holdings")}>
                Edit holdings
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => setDialog("import-holdings")}
              >
                Import holdings (CSV)
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => setDialog("transaction")}
              >
                Add transaction
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => setDialog("import-transactions")}
              >
                Import transactions (CSV)
              </button>
              <button
                type="button"
                className={`${buttonClass} ml-auto text-red-700 dark:text-red-400`}
                onClick={() => setDialog("delete-account")}
              >
                Delete account
              </button>
            </div>
          )}

          {manualSelected && manualSelected.subtype === TSP_SUBTYPE && (
            <TspPanel
              accountId={manualSelected.id}
              balanceMinor={manualSelected.valueMinor}
              onChanged={reloadAll}
            />
          )}

          {overview && (
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-xs text-slate-500">
                {selected ? selected.name : "Total value"}
              </div>
              <div className="text-3xl font-semibold tabular-nums">
                {money(overview.totalValueMinor)}
              </div>
              <div className="mt-1 text-sm">
                <Gain basis={overview.costBasis} />
              </div>
              {Math.abs(overview.totalValueMinor - overview.holdingsValueMinor) >
                Math.max(100, overview.totalValueMinor * 0.01) && (
                <p className="mt-1 text-xs text-slate-500">
                  {money(overview.holdingsValueMinor)} of this is broken down into holdings below.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <h2 className="mb-3 text-lg font-semibold">Allocation</h2>
              {overview && overview.allocation.length > 0 ? (
                <Donut
                  slices={overview.allocation.map((s) => ({
                    key: s.assetClass,
                    label: s.assetClass,
                    value: s.valueMinor,
                  }))}
                  format={money}
                />
              ) : (
                <p className="text-sm text-slate-500">No holdings to break down yet.</p>
              )}
            </div>
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <h2 className="mb-3 text-lg font-semibold">Value over time</h2>
              {history.data && history.data.total.length > 0 ? (
                <>
                  <LineChart
                    series={
                      accountId || history.data.accounts.length < 2
                        ? [
                            {
                              key: "total",
                              label: "Value",
                              color: colorAt(0),
                              points: history.data.total.map((p) => ({
                                date: p.date,
                                value: p.valueMinor,
                              })),
                            },
                          ]
                        : history.data.accounts.map((a, i) => ({
                            key: String(a.accountId),
                            label: a.name,
                            color: a.color ?? colorAt(i),
                            points: a.points.map((p) => ({ date: p.date, value: p.valueMinor })),
                          }))
                    }
                    format={money}
                    formatAxis={formatAxisMoney}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Dots are the days a value was recorded (each sync, or each update by hand).
                    Nothing is estimated between them.
                  </p>
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  {history.error ??
                    "No history yet. A point is recorded each time an account syncs or you update it."}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="mb-3 text-lg font-semibold">Holdings</h2>
            {holdings.data && holdings.data.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th scope="col" className="pb-2 font-medium">
                        Holding
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Type
                      </th>
                      {!accountId && (
                        <th scope="col" className="pb-2 font-medium">
                          Account
                        </th>
                      )}
                      <th scope="col" className="pb-2 text-right font-medium">
                        Shares
                      </th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        Price
                      </th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        Value
                      </th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        Gain
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.data.map((h) => (
                      <tr key={h.key} className="border-t border-slate-100 dark:border-slate-700">
                        <td className="py-2 pr-3">
                          <button
                            type="button"
                            className="text-left font-medium hover:underline"
                            title="Show everything stored about this holding"
                            onClick={() =>
                              setViewSecurity({ id: h.securityId, title: h.symbol ?? h.name })
                            }
                          >
                            {h.symbol ?? h.name}
                          </button>
                          {h.symbol && <div className="text-xs text-slate-500">{h.name}</div>}
                          {h.vestedValueMinor !== null && (
                            <div className="text-xs text-slate-500">
                              {money(h.vestedValueMinor)} vested
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3">{h.assetClass}</td>
                        {!accountId && <td className="py-2 pr-3">{h.accountName}</td>}
                        <td className="py-2 text-right tabular-nums">
                          {formatQuantity(h.quantity)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {h.price === null
                            ? "—"
                            : new Intl.NumberFormat(undefined, {
                                style: "currency",
                                currency: "USD",
                                maximumFractionDigits: 4,
                              }).format(h.price)}
                        </td>
                        <td className="py-2 text-right tabular-nums">{money(h.valueMinor)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {h.gainMinor === null ? (
                            <span className="text-slate-400" title="Cost basis unknown">
                              —
                            </span>
                          ) : (
                            <span
                              className={
                                h.gainMinor >= 0
                                  ? "text-green-700 dark:text-green-400"
                                  : "text-red-600 dark:text-red-400"
                              }
                            >
                              {h.gainMinor >= 0 ? "+" : "−"}
                              {money(Math.abs(h.gainMinor))}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                {holdings.error ??
                  (manualSelected
                    ? "Nothing entered yet. Use “Edit holdings” or import a CSV file."
                    : selected && selected.valueMinor > 0
                      ? "Your institution reports a balance for this account but no holdings (some do not share them), so only the total is tracked."
                      : "No holdings yet. They appear after the account syncs.")}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              A dash in the Gain column means the cost of that holding is not known, so no gain is
              claimed.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="mb-3 text-lg font-semibold">Activity</h2>
            {rows.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th scope="col" className="pb-2 font-medium">
                          Date
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          Activity
                        </th>
                        {!accountId && (
                          <th scope="col" className="pb-2 font-medium">
                            Account
                          </th>
                        )}
                        <th scope="col" className="pb-2 text-right font-medium">
                          Cash
                        </th>
                        <th scope="col" className="pb-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t) => {
                        // Stored positive = cash left the account; shown the way people read it.
                        const cashIn = -t.amountMinor;
                        return (
                          <tr
                            key={t.id}
                            className="border-t border-slate-100 dark:border-slate-700"
                          >
                            <td className="py-2 pr-3 whitespace-nowrap">{formatDay(t.date)}</td>
                            <td className="py-2 pr-3">
                              <div>{t.name}</div>
                              <div className="text-xs text-slate-500">
                                {TYPE_LABEL[t.type] ?? t.type}
                                {t.quantity !== null
                                  ? ` · ${formatQuantity(t.quantity)} shares`
                                  : ""}
                                {t.symbol ? ` · ${t.symbol}` : ""}
                                {t.subtype && t.subtype.toLowerCase() !== t.type
                                  ? ` · ${t.subtype}`
                                  : ""}
                              </div>
                            </td>
                            {!accountId && <td className="py-2 pr-3">{t.accountName}</td>}
                            <td className="py-2 text-right tabular-nums">
                              <span
                                className={
                                  cashIn >= 0
                                    ? "text-green-700 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                                }
                              >
                                {cashIn >= 0 ? "+" : "−"}
                                {money(Math.abs(cashIn))}
                              </span>
                            </td>
                            <td className="space-x-3 py-2 pl-2 text-right whitespace-nowrap">
                              <button
                                type="button"
                                className="text-xs text-blue-700 underline dark:text-blue-400"
                                onClick={() => setViewTransaction(t.id)}
                                aria-label={`Details of the ${TYPE_LABEL[t.type] ?? t.type} on ${t.date}`}
                              >
                                Details
                              </button>
                              {t.source === "manual" && (
                                <button
                                  type="button"
                                  className="text-xs text-red-700 underline dark:text-red-400"
                                  onClick={() => setDeletingTransaction(t)}
                                  aria-label={`Delete the ${TYPE_LABEL[t.type] ?? t.type} on ${t.date}`}
                                >
                                  Delete
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <span>
                    Showing {rows.length} of {total}. “+” is cash coming into the account.
                  </span>
                  {rows.length < total && (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => setLimit((l) => l + PAGE_SIZE)}
                    >
                      Show more
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">
                {activity.error ?? "No activity recorded yet."}
              </p>
            )}
          </div>
        </>
      )}

      {dialog === "new-tsp" && (
        <TspAccountDialog
          onCreated={(id) => {
            setAccountId(String(id));
            changed(
              "TSP account created. Enter what it holds with “Edit holdings”, and add a recurring contribution below.",
            );
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "new-account" && (
        <ManualAccountDialog
          onCreated={(id) => {
            setAccountId(String(id));
            changed("Account created. Add what it holds with “Edit holdings” or a CSV import.");
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "holdings" && manualSelected && (
        <HoldingsEditor
          accountId={manualSelected.id}
          accountName={manualSelected.name}
          onSaved={changed}
          onCancel={() => setDialog(null)}
        />
      )}
      {(dialog === "import-holdings" || dialog === "import-transactions") && manualSelected && (
        <CsvImportDialog
          kind={dialog === "import-holdings" ? "holdings" : "transactions"}
          accountId={manualSelected.id}
          accountName={manualSelected.name}
          onDone={changed}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "transaction" && manualSelected && (
        <TransactionForm
          accountId={manualSelected.id}
          accountName={manualSelected.name}
          onSaved={changed}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete-account" && manualSelected && (
        <ConfirmDialog
          title={`Delete ${manualSelected.name}?`}
          message="This removes the account, its holdings, its recorded history, and its transactions from this app. It cannot be undone."
          confirmLabel="Delete account"
          danger
          busy={busy}
          onConfirm={() => void deleteAccount()}
          onCancel={() => setDialog(null)}
        />
      )}
      {viewSecurity && (
        <SecurityDetailDialog
          securityId={viewSecurity.id}
          title={viewSecurity.title}
          onClose={() => setViewSecurity(null)}
        />
      )}
      {viewTransaction !== null && (
        <InvestmentTransactionDialog
          transactionId={viewTransaction}
          onClose={() => setViewTransaction(null)}
        />
      )}
      {deletingTransaction && (
        <ConfirmDialog
          title="Delete this transaction?"
          message={`${deletingTransaction.name} on ${formatDay(deletingTransaction.date)} will be removed.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void deleteTransaction()}
          onCancel={() => setDeletingTransaction(null)}
        />
      )}
    </section>
  );
}
