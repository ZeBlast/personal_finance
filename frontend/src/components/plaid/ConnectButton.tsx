import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { ExchangeResult, LinkTokenResponse, PlaidItem } from "../../types/api";
import { FakeLinkDialog } from "./FakeLinkDialog";
import { PlaidLauncher } from "./PlaidLauncher";

interface Props {
  label: string;
  /** Set to re-authenticate an existing connection (Plaid "update mode"). */
  reconnect?: Pick<PlaidItem, "id" | "institutionName"> | undefined;
  primary?: boolean;
  /** What is being connected: a bank (default) or a brokerage / retirement plan. */
  kind?: "banking" | "investments";
  /** Called after a successful link or re-authentication, with a notice and the connection's ID. */
  onDone: (notice: string, itemId: number) => void;
  onError: (message: string) => void;
}

/**
 * Starts Plaid Link for a new connection, or update-mode Link to repair an existing one. In demo
 * mode a built-in dialog stands in for Plaid's window; otherwise Plaid's real Link opens.
 */
export function ConnectButton({ label, reconnect, primary, kind, onDone, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<LinkTokenResponse | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    try {
      const path = reconnect ? `/plaid/items/${reconnect.id}/link-token` : "/plaid/link-token";
      setSession(
        await api<LinkTokenResponse>(path, {
          method: "POST",
          ...(kind && !reconnect ? { body: JSON.stringify({ kind }) } : {}),
        }),
      );
    } catch (error) {
      onError(errorMessage(error, "Could not start the connection."));
      setBusy(false);
    }
  }

  function finish(): void {
    setSession(null);
    setBusy(false);
  }

  async function linked(
    publicToken: string,
    institution: { id: string; name: string } | null,
  ): Promise<void> {
    try {
      if (reconnect) {
        await api(`/plaid/items/${reconnect.id}/reauthenticated`, {
          method: "POST",
          body: JSON.stringify({ publicToken }),
        });
        onDone(`${reconnect.institutionName} is connected again.`, reconnect.id);
      } else {
        const result = await api<ExchangeResult>("/plaid/exchange-token", {
          method: "POST",
          body: JSON.stringify({ publicToken, ...(institution ? { institution } : {}) }),
        });
        const notices = [
          result.warning,
          result.duplicateOfItemId !== undefined
            ? `You already had a connection to ${result.item.institutionName}. If this one is a duplicate, disconnect one of them.`
            : undefined,
        ].filter(Boolean);
        onDone(
          notices.length > 0 ? notices.join(" ") : `${result.item.institutionName} connected.`,
          result.item.id,
        );
      }
    } catch (error) {
      onError(errorMessage(error, "Could not finish connecting."));
    } finally {
      finish();
    }
  }

  const isDemo = session?.environment === "fake";

  return (
    <>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className={`rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${
          primary
            ? "bg-blue-600 text-white hover:bg-blue-700"
            : "border border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
        }`}
      >
        {busy ? "Working..." : label}
      </button>

      {session && isDemo && (
        <FakeLinkDialog
          reconnectName={reconnect?.institutionName}
          onSuccess={(token, institution) => void linked(token, institution)}
          onCancel={finish}
        />
      )}
      {session && !isDemo && (
        <PlaidLauncher
          linkToken={session.linkToken}
          onSuccess={(token, institution) => void linked(token, institution)}
          onExit={finish}
        />
      )}
    </>
  );
}
