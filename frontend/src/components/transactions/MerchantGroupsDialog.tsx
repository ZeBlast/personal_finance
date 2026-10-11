import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { Modal } from "../common/Modal";

interface MerchantGroup {
  id: number;
  name: string;
  merchants: Array<{ key: string; name: string }>;
}

interface MerchantRow {
  key: string;
  merchant: string;
  transactionCount: number;
}

/**
 * Merchant groups: several merchants counted as one ("AMZN Mktp", "Amazon.com" as Amazon), shown
 * as one node in the network. Pick merchants by searching, name the group, save.
 */
export function MerchantGroupsDialog({
  onChanged,
  onClose,
}: {
  onChanged: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const groups = useApi<MerchantGroup[]>("/merchant-groups");
  const [search, setSearch] = useState("");
  const merchants = useApi<{ total: number; rows: MerchantRow[] }>(
    `/merchants?limit=40${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`,
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groupOf = new Map(
    (groups.data ?? []).flatMap((g) => g.merchants.map((m) => [m.key, g] as const)),
  );

  function start(g: MerchantGroup | null): void {
    setEditing(g?.id ?? null);
    setName(g?.name ?? "");
    setPicked(new Map((g?.merchants ?? []).map((m) => [m.key, m.name])));
    setError(null);
  }

  function toggle(row: MerchantRow): void {
    setPicked((p) => {
      const next = new Map(p);
      if (next.has(row.key)) next.delete(row.key);
      else next.set(row.key, row.merchant);
      return next;
    });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, merchants: [...picked.values()] });
      if (editing === null) await api("/merchant-groups", { method: "POST", body });
      else await api(`/merchant-groups/${editing}`, { method: "PUT", body });
      start(null);
      groups.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save the group."));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(merchant: string): Promise<void> {
    try {
      await api("/merchant-groups/membership", {
        method: "PUT",
        body: JSON.stringify({ merchant, groupId: null }),
      });
      groups.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not remove the merchant."));
    }
  }

  async function remove(g: MerchantGroup): Promise<void> {
    try {
      await api(`/merchant-groups/${g.id}`, { method: "DELETE" });
      if (editing === g.id) start(null);
      groups.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not remove the group."));
    }
  }

  return (
    <Modal title="Group merchants" onClose={onClose} wide dismissible>
      <div className="space-y-4 text-sm">
        <p className="text-slate-500">
          Merchants in a group count as one: their transactions show the group's name (the
          merchant's own name stays in each transaction's details), and they share one node in the
          network. Every spelling of a merchant belongs (such as "Chipotle 2041" and "Chipotle
          #1999").
        </p>

        {(groups.data ?? []).length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {groups.data!.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-medium">{g.name}</span>
                <span className="flex min-w-0 flex-1 flex-wrap gap-1 text-xs">
                  {g.merchants.map((m) => (
                    <span
                      key={m.key}
                      className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700"
                    >
                      {m.name}
                      <button
                        type="button"
                        aria-label={`Remove ${m.name} from ${g.name}`}
                        title="Remove from the group"
                        className="text-slate-500 hover:text-red-600"
                        onClick={() => void removeMember(m.name)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </span>
                <button type="button" className="text-xs hover:underline" onClick={() => start(g)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline dark:text-red-400"
                  onClick={() => void remove(g)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <p className="font-medium">{editing === null ? "New group" : "Edit group"}</p>
          <div>
            <label htmlFor={`${id}-name`} className="block text-xs font-medium">
              Group name
            </label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              placeholder="Amazon"
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
            />
          </div>
          {picked.size > 0 && (
            <p className="text-xs">In this group: {[...picked.values()].join(", ")}</p>
          )}
          <div>
            <label htmlFor={`${id}-search`} className="block text-xs font-medium">
              Find merchants
            </label>
            <input
              id={`${id}-search`}
              type="search"
              value={search}
              placeholder="amazon"
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
            />
          </div>
          <ul className="max-h-60 overflow-auto rounded border border-slate-100 dark:border-slate-700">
            {(merchants.data?.rows ?? []).map((m) => {
              const other = groupOf.get(m.key);
              return (
                <li key={m.key}>
                  <label className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <input type="checkbox" checked={picked.has(m.key)} onChange={() => toggle(m)} />
                    <span className="flex-1">{m.merchant}</span>
                    {other && other.id !== editing && (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        in {other.name}
                      </span>
                    )}
                    <span className="text-xs text-slate-500">{m.transactionCount}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {editing !== null && (
              <button
                type="button"
                className="rounded border border-slate-300 px-3 py-1.5 dark:border-slate-600"
                onClick={() => start(null)}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={busy || name.trim() === "" || picked.size === 0}
              onClick={() => void save()}
              className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Saving..." : editing === null ? "Create group" : "Save group"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
