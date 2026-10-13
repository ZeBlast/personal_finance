import { useEffect, useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import type { Settings } from "../../types/api";

const inputClass =
  "block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const buttonClass =
  "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

/** Names as typed in the box (one per line or comma-separated), cleaned. Pure, for testing. */
export function parseOwnNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (name.length < 3 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, 10);
}

/**
 * The names you go by on bank descriptions. Money sent to or from them (a Zelle to your other
 * bank, a Cash App cash-out) is filed under Transfers > Own Accounts, so it never counts as
 * income or spending.
 */
export function OwnNamesSection({ onSaved }: { onSaved: () => void }) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Settings>("/settings")
      .then((s) => {
        const value = s.ownNames.join("\n");
        setText(value);
        setSaved(value);
      })
      .catch(() => setText(""));
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const s = await api<Settings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ ownNames: parseOwnNames(text ?? "") }),
      });
      const value = s.ownNames.join("\n");
      setText(value);
      setSaved(value);
      setMessage(
        s.ownNames.length > 0
          ? "Saved. Money to and from these names is filed under Own Accounts."
          : "Saved.",
      );
      onSaved();
    } catch (e) {
      setMessage(errorMessage(e, "Could not save the names."));
    } finally {
      setBusy(false);
    }
  }

  if (text === null) return null;
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
    >
      <label htmlFor={`${id}-names`} className="block font-medium">
        Names you go by
      </label>
      <p className="text-slate-500 dark:text-slate-400">
        As they appear on bank descriptions, one per line (for example your full name, or your Cash
        App name). Money sent to or from them is moving your own money: it is filed under Transfers
        › Own Accounts and never counts as income or spending.
      </p>
      <textarea
        id={`${id}-names`}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={inputClass}
      />
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass} disabled={busy || text === saved}>
          {busy ? "Saving..." : "Save names"}
        </button>
        {message && (
          <span role="status" className="text-slate-600 dark:text-slate-300">
            {message}
          </span>
        )}
      </div>
    </form>
  );
}
