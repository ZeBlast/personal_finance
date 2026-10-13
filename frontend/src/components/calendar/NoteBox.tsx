import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import { clearDraft, keepDraft, readDraft } from "./noteDrafts";

/**
 * The note for one day, edited right where it is shown. There is no Save button: it is saved when
 * the box loses focus, when another day is chosen, and when the day is deselected (the box then
 * goes away, and what was typed is saved on its way out). Clearing the text and leaving removes
 * the note.
 */
export function NoteBox({
  day,
  saved,
  placeholder,
  autoFocus,
}: {
  day: string;
  /** The note as stored; "" for none. */
  saved: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  // A note that failed to save earlier comes back, to be saved this time.
  const [draft] = useState(() => {
    const kept = readDraft(day);
    return kept !== null && kept.trim() !== saved.trim() ? kept : null;
  });
  const [text, setText] = useState(draft ?? saved);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error" | "recovered">(
    draft !== null ? "recovered" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // What is typed and what is stored, readable from the cleanup that runs when the box goes away.
  const typed = useRef(draft ?? saved);
  const stored = useRef(saved.trim());
  const dayRef = useRef(day);
  dayRef.current = day;

  async function save(): Promise<void> {
    const value = typed.current.trim();
    if (value === stored.current) return;
    stored.current = value;
    setState("saving");
    setError(null);
    try {
      await api(`/calendar/notes/${dayRef.current}`, {
        method: "PUT",
        body: JSON.stringify({ note: value }),
      });
      setState("saved");
      clearDraft(dayRef.current);
      announceDataChanged();
    } catch (e) {
      // Try again at the next chance rather than pretending it was saved, and keep what was
      // typed in case the box is gone by then.
      keepDraft(dayRef.current, value);
      stored.current = "\u0000unsaved";
      setError(errorMessage(e, "Could not save the note."));
      setState("error");
    }
  }

  // A note that arrives from the server fills the box, unless something unsaved is being typed.
  useEffect(() => {
    if (typed.current.trim() === stored.current) {
      typed.current = saved;
      stored.current = saved.trim();
      setText(saved);
    }
  }, [saved]);

  // Leaving (another day, or the day being deselected) saves what is there.
  useEffect(
    () => () => {
      void save();
    },
    [],
  );

  return (
    <div className="space-y-1">
      <label htmlFor={`note-${day}`} className="block text-sm font-medium">
        Note for {formatDay(day)}
      </label>
      <textarea
        id={`note-${day}`}
        value={text}
        rows={4}
        maxLength={4000}
        autoFocus={autoFocus}
        placeholder={placeholder ?? "Write a note for this day"}
        onChange={(e) => {
          typed.current = e.target.value;
          setText(e.target.value);
          setState("idle");
        }}
        onBlur={() => void save()}
        className="block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
      />
      <div className="h-4 text-xs" aria-live="polite">
        {state === "saving" && <span className="text-slate-500">Saving...</span>}
        {state === "saved" && (
          <span className="text-green-700 dark:text-green-400">
            {typed.current.trim() === "" ? "Note removed." : "Saved."}
          </span>
        )}
        {state === "recovered" && (
          <span className="text-amber-700 dark:text-amber-400">
            This note was not saved last time.{" "}
            <button type="button" className="underline" onClick={() => void save()}>
              Save it now
            </button>
          </span>
        )}
        {error && (
          <span role="alert" className="text-red-600">
            {error} It is kept here until it saves.{" "}
            <button type="button" className="underline" onClick={() => void save()}>
              Try again
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
