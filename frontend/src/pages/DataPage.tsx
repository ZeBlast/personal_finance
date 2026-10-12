import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, errorMessage, insideTauri } from "../api/client";
import { ConfirmDialog } from "../components/common/Modal";
import { RecoveryKeyDialog, SecurityPanel } from "../components/data/SecurityPanel";
import { buttonClass, primaryClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { adviceFor, formatBytes, formatReport } from "../lib/recovery";
import { announceDataChanged } from "../lib/syncEvents";
import type {
  BackupInfo,
  BackupList,
  Diagnostics,
  ExportKind,
  ExportResult,
  IntegrityReport,
} from "../types/data";
import type { Settings } from "../types/api";
import { Select } from "../components/common/Select";

type Notice = { kind: "info" | "error"; text: string };

const KIND_LABEL: Record<BackupInfo["kind"], string> = {
  manual: "Made by you",
  auto: "Automatic",
  "pre-restore": "Saved before a restore",
  "pre-update": "Saved before an app update",
};

const EXPORTS: Array<{ kind: ExportKind; label: string; help: string }> = [
  {
    kind: "transactions",
    label: "Transactions (CSV)",
    help: "Every bank transaction with its merchant, category, amount, and account. Opens in Excel.",
  },
  {
    kind: "accounts",
    label: "Accounts (CSV)",
    help: "Each account with its balance and credit limit.",
  },
  {
    kind: "investment-holdings",
    label: "Investment holdings (CSV)",
    help: "What each investment account holds now.",
  },
  {
    kind: "investment-transactions",
    label: "Investment activity (CSV)",
    help: "Buys, sells, dividends, and contributions.",
  },
  {
    kind: "everything",
    label: "Everything (JSON)",
    help: "All of your data in one file, for your own records. Connection keys and Plaid credentials are never included.",
  },
];

const when = (iso: string): string => new Date(iso).toLocaleString();

/** Shows a file in its folder in the app window; in a browser tab the path is simply shown. */
async function reveal(file: string): Promise<void> {
  if (insideTauri) await revealItemInDir(file);
}

/** Opens one of the app's folders in File Explorer (works in the app window and a browser tab). */
async function openFolder(
  folder: "data" | "backups" | "exports",
  onNotice: (n: Notice) => void,
): Promise<void> {
  try {
    await api("/data/open-folder", { method: "POST", body: JSON.stringify({ folder }) });
  } catch (e) {
    onNotice({ kind: "error", text: errorMessage(e, "The folder could not be opened.") });
  }
}

function Panel({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {intro && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

function BackupsPanel({ onNotice }: { onNotice: (n: Notice) => void }) {
  const list = useApi<BackupList>("/backups");
  const settings = useApi<Settings>("/settings");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);
  // A backup that this computer's key does not open, waiting for the key it was made with.
  const [needKey, setNeedKey] = useState<BackupInfo | null>(null);

  /** Queues a restore; a backup from another computer is retried with the recovery key typed in. */
  async function queueRestore(backup: BackupInfo, recoveryKey?: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/backups/${encodeURIComponent(backup.name)}/restore`, {
        method: "POST",
        body: JSON.stringify(recoveryKey ? { recoveryKey } : {}),
      });
      onNotice({
        kind: "info",
        text: "Restore queued. Close the app and open it again to finish.",
      });
      setNeedKey(null);
      list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "backup_needs_key") {
        setNeedKey(backup);
        if (recoveryKey) onNotice({ kind: "error", text: e.message });
      } else {
        setNeedKey(null);
        onNotice({ kind: "error", text: errorMessage(e, "Could not restore that backup.") });
      }
    } finally {
      setBusy(false);
      setRestoring(null);
    }
  }

  async function run(work: () => Promise<string>, failure: string): Promise<void> {
    setBusy(true);
    try {
      onNotice({ kind: "info", text: await work() });
      list.reload();
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, failure) });
    } finally {
      setBusy(false);
      setRestoring(null);
      setDeleting(null);
    }
  }

  async function saveSetting(patch: Partial<Settings>): Promise<void> {
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      settings.reload();
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, "Could not save that setting.") });
    }
  }

  const backups = list.data?.backups ?? [];
  const pending = list.data?.pendingRestore ?? null;

  return (
    <Panel
      title="Backups"
      intro="A backup is a complete copy of your data. Restoring one replaces what the app has now, and the current data is saved as a backup first, so a restore can be undone."
    >
      {pending && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <strong>A restore is waiting.</strong> Close the app and open it again to finish restoring{" "}
          {pending.name}.{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              void run(async () => {
                await api("/restore/pending", { method: "DELETE" });
                return "The restore was cancelled.";
              }, "Could not cancel the restore.")
            }
          >
            Cancel the restore
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <button
          type="button"
          className={primaryClass}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const made = await api<BackupInfo>("/backups", { method: "POST" });
              return `Backup saved (${formatBytes(made.sizeBytes)}).`;
            }, "Could not make the backup.")
          }
        >
          {busy ? "Working..." : "Back up now"}
        </button>
        {settings.data && (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.data.autoBackupEnabled}
                onChange={(e) => void saveSetting({ autoBackupEnabled: e.target.checked })}
              />
              Back up automatically when the app opens (at most twice a day)
            </label>
            <label className="flex items-center gap-2">
              Keep the latest
              <Select
                aria-label="Automatic backups to keep"
                value={settings.data.backupsToKeep}
                onChange={(e) => void saveSetting({ backupsToKeep: Number(e.target.value) })}
                className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
              >
                {[3, 5, 10, 20, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              automatic backups
            </label>
          </>
        )}
      </div>

      {list.error && (
        <p role="alert" className="text-sm text-red-600">
          {list.error}
        </p>
      )}
      {list.data && backups.length === 0 && (
        <p className="text-sm text-slate-500">No backups yet.</p>
      )}
      {backups.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {backups.map((b) => (
            <li
              key={b.name}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <div>
                <div className="font-medium">
                  {KIND_LABEL[b.kind]} · {when(b.createdAt)}
                </div>
                <div className="text-xs text-slate-500">
                  {formatBytes(b.sizeBytes)} · {b.name}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || pending !== null}
                  aria-label={`Restore the backup from ${when(b.createdAt)}`}
                  onClick={() => setRestoring(b)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  aria-label={`Delete the backup from ${when(b.createdAt)}`}
                  onClick={() => setDeleting(b)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.data && (
        <p className="text-xs text-slate-500">
          Saved in {list.data.directory}
          {insideTauri && backups[0] && (
            <>
              {" "}
              <button
                type="button"
                className="underline"
                onClick={() => void reveal(`${list.data!.directory}\\${backups[0]!.name}`)}
              >
                Show in folder
              </button>
            </>
          )}
        </p>
      )}

      {restoring && (
        <ConfirmDialog
          title="Restore this backup?"
          message={
            <>
              Your data will be replaced with the backup from{" "}
              <strong>{when(restoring.createdAt)}</strong> the next time the app opens. Anything
              added since then will be gone from view, but the current data is kept as a backup
              first. Nothing changes until you close and reopen the app.
            </>
          }
          confirmLabel="Restore at next launch"
          danger
          busy={busy}
          onConfirm={() => void queueRestore(restoring)}
          onCancel={() => setRestoring(null)}
        />
      )}
      {needKey && (
        <RecoveryKeyDialog
          backupLabel={when(needKey.createdAt)}
          busy={busy}
          onSubmit={(key) => void queueRestore(needKey, key)}
          onCancel={() => setNeedKey(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this backup?"
          message={`The backup from ${when(deleting.createdAt)} will be removed for good.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              await api(`/backups/${encodeURIComponent(deleting.name)}`, { method: "DELETE" });
              return "Backup deleted.";
            }, "Could not delete that backup.")
          }
          onCancel={() => setDeleting(null)}
        />
      )}
    </Panel>
  );
}

function ExportPanel({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [last, setLast] = useState<ExportResult | null>(null);

  async function make(kind: ExportKind): Promise<void> {
    setBusy(kind);
    try {
      const result = await api<ExportResult>("/exports", {
        method: "POST",
        body: JSON.stringify({ kind }),
      });
      setLast(result);
      onNotice({
        kind: "info",
        text: `Exported ${result.rows} rows (${formatBytes(result.sizeBytes)}).`,
      });
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, "Could not make the export.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Export your data"
      intro="Save a copy of your data as a file you can open in a spreadsheet or keep. Files are written to the exports folder in your data folder."
    >
      <ul className="space-y-2">
        {EXPORTS.map((e) => (
          <li key={e.kind} className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{e.label}</div>
              <div className="text-xs text-slate-500">{e.help}</div>
            </div>
            <button
              type="button"
              className={buttonClass}
              disabled={busy !== null}
              onClick={() => void make(e.kind)}
              aria-label={`Export ${e.label}`}
            >
              {busy === e.kind ? "Exporting..." : "Export"}
            </button>
          </li>
        ))}
      </ul>
      {last && (
        <p className="text-sm">
          Saved <span className="font-mono text-xs break-all">{last.path}</span>{" "}
          {insideTauri && (
            <button type="button" className="underline" onClick={() => void reveal(last.path)}>
              Show in folder
            </button>
          )}
        </p>
      )}
    </Panel>
  );
}

function DiagnosticsPanel({ onNotice }: { onNotice: (n: Notice) => void }) {
  const { data, error, reload } = useApi<Diagnostics>("/diagnostics");
  const [full, setFull] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function clear(): Promise<void> {
    try {
      const r = await api<{ cleared: number }>("/diagnostics/problems", { method: "DELETE" });
      setFull(null);
      reload();
      onNotice({
        kind: "info",
        text:
          r.cleared > 0
            ? `Cleared ${r.cleared} recorded sync problem${r.cleared === 1 ? "" : "s"}.`
            : "Diagnostics cleared.",
      });
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, "Diagnostics could not be cleared.") });
    } finally {
      setClearing(false);
    }
  }

  const runFull = useCallback(async () => {
    setChecking(true);
    try {
      setFull(await api<IntegrityReport>("/diagnostics/integrity-check", { method: "POST" }));
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, "The check could not run.") });
    } finally {
      setChecking(false);
    }
  }, [onNotice]);

  async function copy(): Promise<void> {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(formatReport(data));
      onNotice({
        kind: "info",
        text: "The report was copied. It holds counts and codes only, no transaction details.",
      });
    } catch {
      onNotice({ kind: "error", text: "The report could not be copied from here." });
    }
  }

  const integrity = full ?? data?.integrity;
  const healthy =
    integrity &&
    integrity.result.length === 1 &&
    integrity.result[0] === "ok" &&
    integrity.brokenReferences === 0;

  return (
    <Panel
      title="Health and diagnostics"
      intro="A check of the app's own data, and the reasons any recent sync failed. Nothing private is included."
    >
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {data && integrity && (
        <>
          <p
            role="status"
            className={`rounded-md px-3 py-2 text-sm ${
              healthy
                ? "bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-200"
                : "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            {healthy
              ? `The database is healthy${full ? " (full check passed)" : ""}.`
              : `Problems were found: ${integrity.result.join("; ")}${
                  integrity.brokenReferences > 0
                    ? `; ${integrity.brokenReferences} broken references`
                    : ""
                }. Restore a backup above, and copy the report below if you ask for help.`}
          </p>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Version</dt>
              <dd>{data.version}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Data source</dt>
              <dd>{data.environment}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Database size</dt>
              <dd>{formatBytes(data.databaseBytes)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Backups</dt>
              <dd>{data.backups.count}</dd>
            </div>
            {Object.entries(data.counts).map(([table, n]) => (
              <div key={table} className="flex justify-between gap-3">
                <dt className="text-slate-500">{table.replace(/_/g, " ")}</dt>
                <dd className="tabular-nums">{n.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs break-all text-slate-500">
              Data folder (the database, and its backups in the backups folder inside):{" "}
              {data.dataDir}
            </p>
            <button
              type="button"
              className={buttonClass}
              onClick={() => void openFolder("data", onNotice)}
            >
              Open data folder
            </button>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Recent sync problems</h3>
              <button
                type="button"
                className={buttonClass}
                disabled={data.recentProblems.length === 0 && full === null}
                onClick={() => setClearing(true)}
              >
                Clear diagnostics
              </button>
            </div>
            {data.recentProblems.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">None. Recent syncs all worked.</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {data.recentProblems.map((p) => {
                  const advice = adviceFor(p.errorCode);
                  return (
                    <li
                      key={p.id}
                      className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-700"
                    >
                      <div className="font-medium">
                        {p.institutionName} · {when(p.startedAt)}{" "}
                        <span className="text-xs font-normal text-slate-500">
                          ({p.trigger}, {p.status}
                          {p.errorCode ? `, ${p.errorCode}` : ""})
                        </span>
                      </div>
                      <div>{advice.summary}</div>
                      <div className="text-slate-600 dark:text-slate-300">
                        {advice.action}{" "}
                        {advice.fixPath && (
                          <Link
                            to={advice.fixPath}
                            className="text-blue-700 underline dark:text-blue-400"
                          >
                            Go there
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={checking}
              onClick={() => void runFull()}
            >
              {checking ? "Checking..." : "Run the full check"}
            </button>
            <button type="button" className={buttonClass} onClick={() => reload()}>
              Refresh
            </button>
            <button type="button" className={buttonClass} onClick={() => void copy()}>
              Copy report
            </button>
          </div>
        </>
      )}
      {clearing && (
        <ConfirmDialog
          title="Clear diagnostics?"
          message="The list of recent sync problems and the last full check are cleared. Your data, successful syncs, and each connection's status (such as needing to sign in again) stay as they are."
          confirmLabel="Clear"
          onConfirm={() => void clear()}
          onCancel={() => setClearing(false)}
        />
      )}
    </Panel>
  );
}

export function DataPage() {
  const [notice, setNotice] = useState<Notice | null>(null);
  // Anything that changes data tells the rest of the app, so open pages refresh.
  const show = useCallback((n: Notice) => {
    setNotice(n);
    announceDataChanged();
  }, []);

  return (
    <section className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Data and backups</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Your data lives only on this computer, encrypted. Back it up, export it, and check that it
          is healthy.
        </p>
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
      <SecurityPanel />
      <BackupsPanel onNotice={show} />
      <ExportPanel onNotice={show} />
      <DiagnosticsPanel onNotice={show} />
    </section>
  );
}
