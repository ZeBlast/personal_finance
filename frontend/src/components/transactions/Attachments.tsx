import { useRef, useState, type ChangeEvent } from "react";
import { api, apiBlob, apiUpload, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import type { Attachment } from "../../types/planning";

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,image/heic,application/pdf,text/plain";
const MAX_BYTES = 10 * 1024 * 1024;

const size = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Receipts and other files on a transaction. They are stored in the app's encrypted database and
 * opened in a new tab; nothing is uploaded anywhere else.
 */
export function Attachments({ transactionId }: { transactionId: number }) {
  const list = useApi<Attachment[]>(`/transactions/${transactionId}/attachments`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function add(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
        await apiUpload(
          `/transactions/${transactionId}/attachments?name=${encodeURIComponent(file.name)}`,
          file,
          file.type || "application/octet-stream",
        );
      }
      list.reload();
    } catch (err) {
      setError(errorMessage(err, "Could not attach that file."));
    } finally {
      setBusy(false);
    }
  }

  async function open(a: Attachment): Promise<void> {
    try {
      const blob = await apiBlob(`/attachments/${a.id}`);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(errorMessage(err, "Could not open the file."));
    }
  }

  async function remove(a: Attachment): Promise<void> {
    if (!window.confirm(`Delete ${a.name}?`)) return;
    try {
      await api(`/attachments/${a.id}`, { method: "DELETE" });
      list.reload();
    } catch (err) {
      setError(errorMessage(err, "Could not delete the file."));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="block text-sm font-medium">Receipts and files</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
        >
          {busy ? "Attaching..." : "Attach a file"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="Attach a receipt or file"
          onChange={(e) => void add(e)}
        />
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
      {(list.data ?? []).length > 0 ? (
        <ul className="mt-1 space-y-1 text-sm">
          {list.data!.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void open(a)}
                className="truncate text-left text-blue-700 hover:underline dark:text-blue-300"
              >
                {a.mime === "application/pdf" ? "📄" : a.mime.startsWith("image/") ? "🖼" : "📝"}{" "}
                {a.name}
              </button>
              <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                {size(a.size)}
                <button
                  type="button"
                  aria-label={`Delete ${a.name}`}
                  onClick={() => void remove(a)}
                  className="text-red-700 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-slate-500">
          None. Pictures, PDFs, and text files up to 10 MB, kept in the app&apos;s encrypted
          database.
        </p>
      )}
    </div>
  );
}
