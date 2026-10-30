import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorMessage } from "../api/client";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { UtilizationSection } from "../components/insights/UtilizationSection";
import { NewAccountDialog } from "../components/accounts/ManualAccountsSection";
import { AccountCardsView } from "../components/accounts/cards/AccountCardsView";
import { ConnectButton } from "../components/plaid/ConnectButton";
import { announceDataChanged, announceSyncFinished, useSyncFinishedCount } from "../lib/syncEvents";
import { timeAgo } from "../lib/time";
import type { ItemStatus, PlaidItem, PlaidStatus } from "../types/api";
import { toast } from "../lib/toast";

type Notice = { kind: "info" | "error"; text: string };

const STATUS_LABEL: Record<ItemStatus, { text: string; className: string }> = {
  active: {
    text: "Connected",
    className: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-200",
  },
  login_required: {
    text: "Needs sign-in",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  },
  error: {
    text: "Problem",
    className: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  },
};

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
  /** The "Add account" window: choosing what to add, or the manual account form. */
  const [addingAccount, setAddingAccount] = useState<"choose" | "manual" | null>(null);

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
      setNotice(null);
      toast(
        localOnly
          ? `${disconnecting.institutionName} was removed from this app.`
          : `${disconnecting.institutionName} was disconnected.`,
      );
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

  /** A collection exported from another copy of the app becomes a new account here. */
  async function importCollectionFile(file: File): Promise<void> {
    try {
      const made = await api<{ name: string; items: unknown[] }>("/collections/import", {
        method: "POST",
        body: await file.text(),
      });
      setAddingAccount(null);
      toast(`${made.name} was imported with ${made.items.length} items.`);
      announceDataChanged();
    } catch (e) {
      setNotice({
        kind: "error",
        text: errorMessage(e, "That file is not a collection exported from this app."),
      });
    }
  }

  /** A finished connection: a warning stays on the page; plain success passes by as a pop-up. */
  function showConnected(text: string, needsAttention: boolean): void {
    if (needsAttention) {
      setNotice({ kind: "info", text });
    } else {
      setNotice(null);
      toast(text);
    }
  }
  const needsSignIn = items?.filter((i) => i.status === "login_required") ?? [];

  /** Reconnect, check and disconnect a bank, in the Bank connections strip. */
  const connectionActions = (item: PlaidItem) => (
    <div className="flex flex-wrap items-center gap-2">
      {item.status === "login_required" && !item.borrowed && (
        <ConnectButton
          label="Reconnect"
          primary
          reconnect={item}
          onDone={(text, itemId, needsAttention) => {
            showConnected(text, needsAttention);
            void syncConnection(itemId);
          }}
          onError={(text) => setNotice({ kind: "error", text })}
        />
      )}
      {item.status === "active" && !item.borrowed && !demo && (
        <ConnectButton
          label="Add or remove accounts"
          reconnect={item}
          chooseAccounts
          onDone={(text, itemId, needsAttention) => {
            showConnected(text, needsAttention);
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
  );

  const signInAlert = (
    <div
      role="alert"
      className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
    >
      {needsSignIn.map((i) => i.institutionName).join(", ")}{" "}
      {needsSignIn.length === 1 ? "needs" : "need"} you to sign in again. Use the Reconnect button;
      your existing data is kept.
    </div>
  );

  const disconnectDialog = disconnecting && (
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
            Deleting only the local copy removes this connection and its accounts from this app, but
            it may stay active at Plaid and still count toward your connection limit.
            {disconnectCause === "token_unreadable" &&
              " Afterwards, connect the institution again."}
          </>
        ) : (
          <>
            This tells Plaid to disconnect and removes {disconnecting.institutionName} and its
            accounts from this app. Anything already imported from it will be deleted too. This
            cannot be undone.
            {status?.environment === "production" && (
              <span className="mt-2 block rounded-md bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Free Plaid accounts can only make a limited number of bank connections, and a
                connection you disconnect may still count toward that limit. Connecting this bank
                again later may use up another one. If it only needs a fresh sign-in, use{" "}
                <strong>Reconnect</strong> instead. Your Plaid dashboard shows how many you have
                left.
              </span>
            )}
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
  );

  return (
    <section className="@container w-full space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Click a card to turn it over for its details and what you can do. Each bank&apos;s
            connection is managed in the strip below.
            {status &&
              (demo
                ? " Demo mode: connections use built-in sample data; switch to Plaid Sandbox or Production in Settings."
                : ` Connected through Plaid (${status.environment}).`)}
          </p>
          {status &&
            status.environment !== "fake" &&
            !status.credentialsSaved[status.environment] && (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                Connecting a bank needs your Plaid keys, and none are saved yet.{" "}
                <Link to="/settings?show=bank" className="underline">
                  Get them and add them in Settings
                </Link>
                .
              </p>
            )}
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setAddingAccount("choose")}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            + Add account
          </button>
        </div>
      </div>
      {addingAccount === "choose" && (
        <Modal title="Add an account" onClose={() => setAddingAccount(null)} dismissible>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <div className="font-medium">Connect a bank</div>
              <p className="flex-1 text-sm text-slate-500">
                Sign in to your bank through Plaid; its accounts and transactions sync on their own.
              </p>
              <ConnectButton
                label="Connect a bank"
                primary
                onDone={(text, itemId, needsAttention) => {
                  setAddingAccount(null);
                  showConnected(text, needsAttention);
                  void syncConnection(itemId);
                }}
                onError={(text) => setNotice({ kind: "error", text })}
              />
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <div className="font-medium">Keep one by hand</div>
              <p className="flex-1 text-sm text-slate-500">
                Cash, a card or account you update yourself, a loan, an asset or a collection.
              </p>
              <button
                type="button"
                onClick={() => setAddingAccount("manual")}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              >
                Add a manual account
              </button>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 sm:col-span-2 dark:border-slate-700">
              <div className="font-medium">Import a collection file</div>
              <p className="flex-1 text-sm text-slate-500">
                A collection exported from another copy of this app becomes a new account here.
              </p>
              <label className="w-fit cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
                Choose a file
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void importCollectionFile(file);
                  }}
                />
              </label>
            </div>
          </div>
        </Modal>
      )}
      {addingAccount === "manual" && (
        <NewAccountDialog
          onCreated={(text) => {
            setAddingAccount(null);
            toast(text);
            announceDataChanged();
          }}
          onClose={() => setAddingAccount(null)}
        />
      )}
      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200"
              : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200"
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
      {needsSignIn.length > 0 && signInAlert}
      {(items ?? []).length > 0 && (
        <section aria-label="Bank connections" className="space-y-2">
          <h2 className="text-sm font-medium text-slate-500">Bank connections</h2>
          <ul className="grid gap-2 @min-[48rem]:grid-cols-2 @min-[80rem]:grid-cols-3">
            {(items ?? []).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    {item.institutionName}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_LABEL[item.status].className}`}
                    >
                      {STATUS_LABEL[item.status].text}
                    </span>
                    {item.borrowed && (
                      <span
                        className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900 dark:bg-violet-950/60 dark:text-violet-200"
                        title="This connection belongs to your real app. This copy can read it, but cannot disconnect or repair it."
                      >
                        Borrowed · read-only
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {item.lastSuccessfulSyncAt
                      ? `Last synced ${timeAgo(item.lastSuccessfulSyncAt)}`
                      : "Not synced yet"}
                    {item.borrowed &&
                      " · syncs only with Sync now; sign-ins and disconnecting happen in the real app"}
                  </div>
                  {item.lastErrorMessage && item.status !== "active" && (
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                      {item.lastErrorMessage}
                    </p>
                  )}
                  {demo && item.status === "active" && (
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                      <button
                        type="button"
                        onClick={() => void simulateExpiry(item)}
                        className="underline"
                      >
                        Demo: simulate an expired login
                      </button>
                      {item.accounts.some((a) => a.type === "credit") && (
                        <button
                          type="button"
                          onClick={() => void simulateLimitChange(item)}
                          className="underline"
                        >
                          Demo: raise the credit limit by $500
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {connectionActions(item)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <AccountCardsView items={items ?? []} />
      <div className="max-w-4xl">
        <UtilizationSection />
      </div>
      {disconnectDialog}
    </section>
  );
}
