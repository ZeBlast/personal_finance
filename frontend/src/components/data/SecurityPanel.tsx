import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { Modal } from "../common/Modal";

interface Encryption {
  encrypted: boolean;
  recoveryKeyAvailable: boolean;
}

/** A recovery key is 64 letters and digits; shown in groups so it is easy to copy by eye. */
export function groupKey(key: string): string {
  return key.replace(/(.{8})(?=.)/g, "$1 ");
}

/** Whether text looks like a recovery key, ignoring spaces and capitals. */
export function normalizeRecoveryKey(text: string): string | null {
  const cleaned = text.replace(/\s+/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : null;
}

/**
 * Says whether the database is encrypted, and lets the user see the recovery key: the one secret
 * that opens the database and every backup. Losing it (a new computer, a Windows reinstall) loses
 * the data unless it was saved somewhere safe.
 */
export function SecurityPanel() {
  const status = useApi<Encryption>("/data/encryption");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function show(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setKey(
        (await api<{ recoveryKey: string }>("/data/recovery-key", { method: "POST" })).recoveryKey,
      );
    } catch (e) {
      setError(errorMessage(e, "Could not show the recovery key."));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      setError("Could not copy it. Select the key and copy it by hand.");
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div>
        <h2 className="text-lg font-semibold">Encryption</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {status.data === null
            ? "Checking..."
            : status.data.encrypted
              ? "Your database and its backups are encrypted on this computer. Without the key, the files cannot be read."
              : "The database file is not encrypted."}
        </p>
      </div>
      {status.data?.recoveryKeyAvailable && (
        <div className="space-y-2 text-sm">
          <p>
            The key is kept in Windows for this user account, so the app opens without asking for
            anything. <strong>If you lose it, you lose your data</strong>, including every backup.
            That happens if you reinstall Windows or move to a new computer. Keep a copy of the
            recovery key somewhere safe, such as a password manager, and not in the same folder as
            your backups.
          </p>
          {key === null ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void show()}
            >
              {busy ? "Working..." : "Show recovery key"}
            </button>
          ) : (
            <div className="space-y-2">
              <code
                aria-label="Recovery key"
                className="block rounded border border-slate-300 bg-slate-50 p-2 font-mono text-sm break-all select-all dark:border-slate-600 dark:bg-slate-900"
              >
                {groupKey(key)}
              </code>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Anyone who has this key and a copy of your database can read it. Do not share it or
                send it by email.
              </p>
              <div className="flex gap-2">
                <button type="button" className={buttonClass} onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    setKey(null);
                    setCopied(false);
                  }}
                >
                  Hide
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Asks for the recovery key of another computer, to restore a backup that computer made. */
export function RecoveryKeyDialog({
  backupLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  backupLabel: string;
  busy: boolean;
  onSubmit: (recoveryKey: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const key = normalizeRecoveryKey(text);
    if (key === null) {
      setProblem("A recovery key is 64 letters and digits (0 to 9, a to f). Spaces are fine.");
      return;
    }
    onSubmit(key);
  }

  return (
    <Modal title="This backup needs a recovery key" onClose={onCancel} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <p>
          The backup from <strong>{backupLabel}</strong> could not be opened with this
          computer&apos;s key. If it was made on another computer, or before a Windows reinstall,
          enter the recovery key from that time. If the file is damaged, no key will open it.
        </p>
        <div>
          <label htmlFor="recovery-key-input" className="block font-medium">
            Recovery key
          </label>
          <input
            id="recovery-key-input"
            value={text}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        {problem && (
          <p role="alert" className="text-red-600">
            {problem}
          </p>
        )}
        <p className="text-xs text-slate-500">
          Your bank connections were saved under the old key and will need to be connected again
          after this restore.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Working..." : "Restore with this key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
