import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";

export interface MerchantGroup {
  id: number;
  name: string;
  merchants: Array<{ key: string; name: string }>;
}

const NEW = "new";

/**
 * Which merchant group this transaction's merchant is in. A grouped merchant shows as its group's
 * name on every transaction; this puts the merchant in a group, makes a new one, or takes it out.
 * Changes apply at once (to every transaction of the merchant), apart from the rest of the form.
 */
export function MerchantGroupField({
  merchant,
  group,
  onChanged,
}: {
  /** The merchant's own name (before grouping). */
  merchant: string;
  group: { id: number; name: string } | null;
  onChanged: () => void;
}) {
  const id = useId();
  const groups = useApi<MerchantGroup[]>("/merchant-groups");
  const [choice, setChoice] = useState<string>(group ? String(group.id) : "");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const current = group ? String(group.id) : "";
  const changed = choice === NEW ? newName.trim() !== "" : choice !== current;

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body =
        choice === NEW
          ? { merchant, newGroup: newName.trim() }
          : { merchant, groupId: choice === "" ? null : Number(choice) };
      await api("/merchant-groups/membership", { method: "PUT", body: JSON.stringify(body) });
      setDone(
        choice === ""
          ? `${merchant} is no longer in a group.`
          : `${merchant} is now in ${choice === NEW ? newName.trim() : (groups.data?.find((g) => String(g.id) === choice)?.name ?? "the group")}.`,
      );
      groups.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not change the group."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label htmlFor={`${id}-group`} className="block text-sm font-medium">
        Merchant group
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`${id}-group`}
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setDone(null);
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600"
        >
          <option value="">No group</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value={NEW}>New group...</option>
        </select>
        {choice === NEW && (
          <input
            aria-label="New group's name"
            value={newName}
            maxLength={100}
            placeholder="Amazon"
            onChange={(e) => setNewName(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
          />
        )}
        <button
          type="button"
          disabled={busy || !changed}
          onClick={() => void apply()}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600"
        >
          {busy ? "Saving..." : choice === "" && group ? "Remove from group" : "Apply"}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {group
          ? `Shown as “${group.name}”. The merchant's own name is “${merchant}”.`
          : "Group merchants that are one place under several names (such as Amazon's). Every transaction of a grouped merchant shows the group's name."}
      </p>
      {done && (
        <p role="status" className="mt-1 text-xs text-green-700 dark:text-green-400">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
