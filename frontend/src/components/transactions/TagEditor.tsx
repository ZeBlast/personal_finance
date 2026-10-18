import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { announceDataChanged } from "../../lib/syncEvents";

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

/** A transaction's tags, saved as soon as one is added or removed. */
export function TagEditor({ transactionId }: { transactionId: number }) {
  const id = useId();
  const own = useApi<Tag[]>(`/transactions/${transactionId}/tags`);
  const all = useApi<Array<Tag & { transactionCount: number }>>("/tags");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = own.data ?? [];

  async function save(tagIds: number[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/transactions/${transactionId}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tagIds }),
      });
      own.reload();
      all.reload();
      announceDataChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save the tags."));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      // Makes the tag, or finds the one with this name.
      const tag = await api<Tag>("/tags", { method: "POST", body: JSON.stringify({ name }) });
      setDraft("");
      if (!current.some((t) => t.id === tag.id)) await save([...current.map((t) => t.id), tag.id]);
    } catch (e) {
      setError(errorMessage(e, "Could not add the tag."));
    }
  }

  return (
    <div className="text-sm">
      <label htmlFor={`${id}-tag`} className="block font-medium">
        Tags
      </label>
      <ul className="mt-1 flex flex-wrap gap-1">
        {current.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800"
          >
            {t.name}
            <button
              type="button"
              disabled={busy}
              aria-label={`Remove the tag ${t.name}`}
              onClick={() => void save(current.filter((x) => x.id !== t.id).map((x) => x.id))}
              className="text-slate-500 hover:text-red-600"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {/* Not a <form>: this sits inside the transaction's own form. */}
      <div className="mt-1 flex gap-2">
        <input
          id={`${id}-tag`}
          list={`${id}-tags`}
          value={draft}
          maxLength={80}
          placeholder="Add a tag, such as Lisbon trip"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add(e);
          }}
          className="block w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        />
        <button
          type="button"
          disabled={busy || draft.trim() === ""}
          onClick={(e) => void add(e)}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm disabled:opacity-60 dark:border-slate-600"
        >
          Add
        </button>
      </div>
      <datalist id={`${id}-tags`}>
        {(all.data ?? [])
          .filter((t) => !current.some((c) => c.id === t.id))
          .map((t) => (
            <option key={t.id} value={t.name} />
          ))}
      </datalist>
      <p className="mt-1 text-xs text-slate-500">
        Tags group spending across categories, such as a trip. A spending monitor on the dashboard
        can follow one.
      </p>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
