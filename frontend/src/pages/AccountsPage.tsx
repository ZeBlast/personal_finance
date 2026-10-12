import { AccountName } from "../components/common/AccountName";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, errorMessage } from "../api/client";
import { ConfirmDialog } from "../components/common/Modal";
import { LimitHistory } from "../components/accounts/LimitHistory";
import { CashbackSection } from "../components/accounts/CashbackSection";
import { HiddenBadge, HideToggle } from "../components/accounts/HideToggle";
import { ManualAccountsSection } from "../components/accounts/ManualAccountsSection";
import { AccountCardsView } from "../components/accounts/cards/AccountCardsView";
import { usePersistentState } from "../hooks/usePersistentState";
import { ConnectButton } from "../components/plaid/ConnectButton";
import { formatMinor } from "../lib/money";
import { announceSyncFinished, useSyncFinishedCount } from "../lib/syncEvents";
import { timeAgo } from "../lib/time";
import type { Account, ItemStatus, PlaidItem, PlaidStatus } from "../types/api";

type Notice = { kind: "info" | "error"; text: string };

const STATUS_LABEL: Record<ItemStatus, { text: string; className: string }> = {
  active: { text: "Connected", className: "bg-green-100 text-green-800" },
  login_required: { text: "Needs sign-in", className: "bg-amber-100 text-amber-900" },
  error: { text: "Problem", className: "bg-red-100 text-red-800" },
};

function AccountRow({
  account,
  onChanged,
  onError,
}: {
  account: Account;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const isCredit = account.type === "credit";
  const used =
    isCredit && account.creditLimitMinor && account.currentBalanceMinor !== null
      ? Math.round((account.currentBalanceMinor / account.creditLimitMinor) * 100)
      : null;
  return (
    <li className={`py-2 text-sm ${account.hidden ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: account.color ?? "#94a3b8" }}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                <AccountName name={account.name} institutionName={account.institutionName} />
              </span>
              {account.hidden && <HiddenBadge />}
            </div>
            <div className="text-xs text-slate-500">
              {[account.subtype ?? account.type, account.mask ? `••${account.mask}` : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-right">
          <div>
            <div className="font-medium">
              {formatMinor(account.currentBalanceMinor, account.currency)}
            </div>
            <div className="text-xs text-slate-500">
              {isCredit
                ? account.creditLimitMinor
                  ? `balance owed · limit ${formatMinor(account.creditLimitMinor, account.currency)}${
                      used === null ? "" : ` · ${used}% used`
                    }`
                  : "balance owed"
                : account.availableBalanceMinor !== null
                  ? `${formatMinor(account.availableBalanceMinor, account.currency)} available`
                  : "current balance"}
            </div>
          </div>
          <HideToggle account={account} onChanged={onChanged} onError={onError} />
        </div>
      </div>
      {isCredit && <LimitHistory account={account} />}
      {isCredit && <CashbackSection account={account} />}
    </li>
  );
}

export function AccountsPage() {
  const [items, setItems] = useState<PlaidItem[] | null>(null);
  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [disconnecting, setDisconnecting] = useState<PlaidItem | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  /** Why the last disconnect attempt failed, to explain the "delete local copy" option. */
  const [disconnectCause, setDisconnectCause] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  /** The experimental card view, remembered between visits. */
  const [cardView, setCardView] = usePersistentState("pf.accounts.cardView", false);

  const load = useCallback(async (): Promise<PlaidItem[]> => {
    try {
      const [list, plaid] = await Promise.all([
        api<PlaidItem[]>("/plaid/items"),
        api<PlaidStatus>("/plaid/status"),
      ]);
      setItems(list);
      setStatus(plaid);
      return list;
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "Could not load your accounts.") });
      return [];
    }
  }, []);

  const replaceItem = (updated: PlaidItem) =>
    setItems((previous) => previous?.map((i) => (i.id === updated.id ? updated : i)) ?? previous);

  // On opening the page, load everything, then quietly ask Plaid whether each connection still works.
  useEffect(() => {
    void (async () => {
      const list = await load();
      for (const item of list) {
        try {
          replaceItem(await api<PlaidItem>(`/plaid/items/${item.id}/check`, { method: "POST" }));
        } catch (error) {
          // Offline or Plaid unavailable: keep showing the last known state. A key problem is
          // different, because the connection can never work again until it is reconnected.
          if (error instanceof ApiError && error.code === "token_unreadable") {
            setNotice({ kind: "error", text: `${item.institutionName}: ${error.message}` });
          }
        }
      }
    })();
  }, [load]);

  // Reload balances, limits and sync times whenever any sync finishes (button, launch, or timer).
  const syncFinished = useSyncFinishedCount();
  useEffect(() => {
    if (syncFinished > 0) void load();
  }, [syncFinished, load]);

  /** A newly connected (or repaired) connection gets its first sync straight away. */
  async function syncConnection(itemId: number): Promise<void> {
    try {
      await load();
      await api("/sync", { method: "POST", body: JSON.stringify({ itemId }) });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "Connected, but the sync failed.") });
    } finally {
      announceSyncFinished();
    }
  }

  async function simulateLimitChange(item: PlaidItem): Promise<void> {
    const card = item.accounts.find((a) => a.type === "credit");
    if (!card) return;
    const dollars = (card.creditLimitMinor ?? 200000) / 100 + 500;
    try {
      await api(`/plaid/fake/items/${item.id}/simulate-credit-limit`, {
        method: "POST",
        body: JSON.stringify({ limit: dollars }),
      });
      await api("/sync", { method: "POST", body: JSON.stringify({ itemId: item.id }) });
      announceSyncFinished();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function check(item: PlaidItem): Promise<void> {
    setCheckingId(item.id);
    try {
      replaceItem(await api<PlaidItem>(`/plaid/items/${item.id}/check`, { method: "POST" }));
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "Could not check the connection.") });
    } finally {
      setCheckingId(null);
    }
  }

  async function simulateExpiry(item: PlaidItem): Promise<void> {
    try {
      replaceItem(
        await api<PlaidItem>(`/plaid/fake/items/${item.id}/simulate-login-required`, {
          method: "POST",
        }),
      );
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function disconnect(): Promise<void> {
    if (!disconnecting) return;
    setDisconnectBusy(true);
    try {
      await api(`/plaid/items/${disconnecting.id}${localOnly ? "?force=1" : ""}`, {
        method: "DELETE",
      });
      setNotice({
        kind: "info",
        text: localOnly
          ? `${disconnecting.institutionName} was removed from this app.`
          : `${disconnecting.institutionName} was disconnected.`,
      });
      setDisconnecting(null);
      setLocalOnly(false);
      setDisconnectCause(null);
      await load();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "Could not disconnect.") });
      // Offer to remove just the local copy when Plaid could not be told.
      setDisconnectCause(error instanceof ApiError ? error.code : null);
      setLocalOnly(true);
    } finally {
      setDisconnectBusy(false);
    }
  }

  const demo = status?.environment === "fake";
  const needsSignIn = items?.filter((i) => i.status === "login_required") ?? [];

  const viewSwitch = (
    <label className="flex w-fit items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={cardView}
        onChange={(e) => setCardView(e.target.checked)}
        className="h-4 w-4"
      />
      Card view{" "}
      <span className="rounded bg-violet-100 px-1.5 text-xs text-violet-800">experimental</span>
    </label>
  );

  if (cardView) {
    return (
      <section className="max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Accounts</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Click a card to turn it over. Connections are managed in the classic view.
            </p>
          </div>
          {viewSwitch}
        </div>
        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`rounded-md px-3 py-2 text-sm ${
              notice.kind === "error" ? "bg-red-100 text-red-900" : "bg-blue-100 text-blue-900"
            }`}
          >
            {notice.text}
          </div>
        )}
        <AccountCardsView items={items ?? []} />
      </section>
    );
  }

  return (
    <section className="max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
          {status && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {demo
                ? "Demo mode: connections use built-in sample data. Switch to Plaid Sandbox or Production in Settings."
                : `Connected through Plaid (${status.environment}).`}
            </p>
          )}
          <div className="mt-2">{viewSwitch}</div>
        </div>
        <ConnectButton
          label="Connect an account"
          primary
          onDone={(text, itemId) => {
            setNotice({ kind: "info", text });
            void syncConnection(itemId);
          }}
          onError={(text) => setNotice({ kind: "error", text })}
        />
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${
            notice.kind === "error" ? "bg-red-100 text-red-900" : "bg-blue-100 text-blue-900"
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="font-bold"
          >
            ×
          </button>
        </div>
      )}

      {needsSignIn.length > 0 && (
        <div role="alert" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
          {needsSignIn.map((i) => i.institutionName).join(", ")}{" "}
          {needsSignIn.length === 1 ? "needs" : "need"} you to sign in again. Use the Reconnect
          button below; your existing data is kept.
        </div>
      )}

      {items === null && <p className="text-sm text-slate-500">Loading...</p>}

      {items?.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-600">
          No accounts connected yet. Choose “Connect an account” to add your first one.
        </div>
      )}

      {items?.map((item) => {
        const label = STATUS_LABEL[item.status];
        return (
          <article
            key={item.id}
            className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="flex items-center gap-2 text-lg font-medium">
                  {item.logo ? (
                    <img
                      src={item.logo}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-full bg-white object-contain p-0.5 ring-1 ring-slate-200 dark:ring-slate-600"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                    >
                      {item.institutionName.trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                  {item.institutionName}
                </h2>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${label.className}`}>
                  {label.text}
                </span>
                {item.borrowed && (
                  <span
                    className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900"
                    title="This connection belongs to your real app. This copy can read it, but cannot disconnect or repair it."
                  >
                    Borrowed · read-only
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.status === "login_required" && !item.borrowed && (
                  <ConnectButton
                    label="Reconnect"
                    primary
                    reconnect={item}
                    onDone={(text, itemId) => {
                      setNotice({ kind: "info", text });
                      void syncConnection(itemId);
                    }}
                    onError={(text) => setNotice({ kind: "error", text })}
                  />
                )}
                <button
                  type="button"
                  onClick={() => void check(item)}
                  disabled={checkingId === item.id}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700"
                >
                  {checkingId === item.id ? "Checking..." : "Check connection"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLocalOnly(false);
                    setDisconnecting(item);
                  }}
                  className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                >
                  {item.borrowed ? "Remove from this copy" : "Disconnect"}
                </button>
              </div>
            </header>

            {item.borrowed && (
              <p className="mt-1 text-xs text-violet-800 dark:text-violet-300">
                Borrowed from your real app. It syncs only when you press Sync now, and signing in
                again or disconnecting has to be done in the real app.
              </p>
            )}

            <p className="mt-1 text-xs text-slate-500">
              {item.lastSuccessfulSyncAt
                ? `Last synced ${timeAgo(item.lastSuccessfulSyncAt)}`
                : "Not synced yet"}
            </p>

            {item.lastErrorMessage && item.status !== "active" && (
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {item.lastErrorMessage}
              </p>
            )}

            <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
              {item.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onChanged={() => void load()}
                  onError={(text) => setNotice({ kind: "error", text })}
                />
              ))}
              {item.accounts.length === 0 && (
                <li className="py-2 text-sm text-slate-500">No accounts loaded yet.</li>
              )}
            </ul>

            {demo && item.status === "active" && (
              <button
                type="button"
                onClick={() => void simulateExpiry(item)}
                className="mt-2 text-xs text-slate-500 underline"
              >
                Demo: simulate an expired login
              </button>
            )}
            {demo && item.status === "active" && item.accounts.some((a) => a.type === "credit") && (
              <button
                type="button"
                onClick={() => void simulateLimitChange(item)}
                className="mt-2 ml-4 text-xs text-slate-500 underline"
              >
                Demo: raise the credit limit by $500
              </button>
            )}
          </article>
        );
      })}

      {disconnecting && (
        <ConfirmDialog
          title={
            disconnecting.borrowed
              ? `Remove ${disconnecting.institutionName} from this copy?`
              : localOnly
                ? "Delete the local copy only?"
                : `Disconnect ${disconnecting.institutionName}?`
          }
          message={
            disconnecting.borrowed ? (
              <>
                This only removes the borrowed copy and what it imported from this app. Plaid is not
                told anything, so the connection in your real app is not affected. You can borrow it
                again later.
              </>
            ) : localOnly ? (
              <>
                {disconnectCause === "token_unreadable"
                  ? "This app can no longer read the saved connection (its encryption key changed), so it cannot tell Plaid to disconnect."
                  : "Plaid could not be reached, so it has not been told to disconnect."}{" "}
                Deleting only the local copy removes this connection and its accounts from this app,
                but it may stay active at Plaid and still count toward your connection limit.
                {disconnectCause === "token_unreadable" &&
                  " Afterwards, connect the institution again."}
              </>
            ) : (
              <>
                This tells Plaid to disconnect and removes {disconnecting.institutionName} and its
                accounts from this app. Anything already imported from it will be deleted too. This
                cannot be undone.
              </>
            )
          }
          confirmLabel={
            disconnecting.borrowed
              ? "Remove from this copy"
              : localOnly
                ? "Delete local copy"
                : "Disconnect"
          }
          danger
          busy={disconnectBusy}
          onConfirm={() => void disconnect()}
          onCancel={() => {
            setDisconnecting(null);
            setLocalOnly(false);
            setDisconnectCause(null);
          }}
        />
      )}

      <ManualAccountsSection />
    </section>
  );
}
