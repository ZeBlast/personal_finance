import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { formatDay } from "../../lib/time";
import { Modal } from "../common/Modal";
import { askConfirm } from "../common/ConfirmHost";
import { toast } from "../../lib/toast";
import { Loading } from "../common/Loading";

/**
 * Saving and loading named copies of a sandbox drawing (the maths nodes or the cash-flow map). The
 * drawing on screen is always saved by itself; these are extra, named copies to come back to. A copy
 * can also be downloaded as a file and loaded from one.
 */

export type MapKind = "math" | "flow";

interface SavedMap {
  id: number;
  kind: MapKind;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const CURRENT_KEY = (kind: MapKind) => `pf.sandbox.saved.${kind}`;

function readCurrent(kind: MapKind): { id: number; name: string } | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY(kind));
    return raw ? (JSON.parse(raw) as { id: number; name: string }) : null;
  } catch {
    return null;
  }
}
function writeCurrent(kind: MapKind, value: { id: number; name: string } | null): void {
  try {
    if (value) localStorage.setItem(CURRENT_KEY(kind), JSON.stringify(value));
    else localStorage.removeItem(CURRENT_KEY(kind));
  } catch {
    // Remembered for this visit only.
  }
}

const buttonClass =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800";

export function SavedMaps({
  kind,
  getData,
  onLoad,
}: {
  kind: MapKind;
  /** The drawing as it is now, to save. */
  getData: () => Record<string, unknown>;
  /** Puts a loaded drawing on screen. */
  onLoad: (data: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(() => readCurrent(kind));
  const [notice, setNotice] = useState<string | null>(null);

  const setLoaded = (value: { id: number; name: string } | null) => {
    setCurrent(value);
    writeCurrent(kind, value);
  };

  async function saveOver(): Promise<void> {
    if (!current) return;
    try {
      await api(`/sandbox/saves/${current.id}`, {
        method: "PUT",
        body: JSON.stringify({ data: getData() }),
      });
      setNotice(`Saved “${current.name}”.`);
    } catch (e) {
      // The copy may have been deleted elsewhere: forget it, so "Save" offers a new name.
      setLoaded(null);
      setNotice(errorMessage(e, "Could not save."));
    }
  }

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  return (
    <span className="flex items-center gap-1.5">
      {current && (
        <span
          className="max-w-40 truncate text-xs text-slate-500"
          title="The saved map you last loaded or saved"
        >
          {current.name}
        </span>
      )}
      {current && (
        <button
          type="button"
          className={buttonClass}
          onClick={() => void saveOver()}
          title={`Save over “${current.name}”`}
        >
          Save
        </button>
      )}
      <button type="button" className={buttonClass} onClick={() => setOpen(true)}>
        {current ? "Maps…" : "Save or load…"}
      </button>
      {notice && (
        <span role="status" className="text-xs text-green-700 dark:text-green-400">
          {notice}
        </span>
      )}
      {open && (
        <MapsDialog
          kind={kind}
          current={current}
          getData={getData}
          onLoad={(data, map) => {
            onLoad(data);
            setLoaded(map ? { id: map.id, name: map.name } : null);
            setOpen(false);
            setNotice(map ? `Loaded “${map.name}”.` : "Loaded from the file.");
          }}
          onSaved={(map) => {
            setLoaded({ id: map.id, name: map.name });
            setNotice(`Saved “${map.name}”.`);
          }}
          onDeleted={(id) => {
            if (current?.id === id) setLoaded(null);
          }}
          onRenamed={(map) => {
            if (current?.id === map.id) setLoaded({ id: map.id, name: map.name });
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function MapsDialog({
  kind,
  current,
  getData,
  onLoad,
  onSaved,
  onDeleted,
  onRenamed,
  onClose,
}: {
  kind: MapKind;
  current: { id: number; name: string } | null;
  getData: () => Record<string, unknown>;
  onLoad: (data: Record<string, unknown>, map: SavedMap | null) => void;
  onSaved: (map: SavedMap) => void;
  onDeleted: (id: number) => void;
  onRenamed: (map: SavedMap) => void;
  onClose: () => void;
}) {
  const [maps, setMaps] = useState<SavedMap[] | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const reload = () =>
    api<SavedMap[]>(`/sandbox/saves?kind=${kind}`)
      .then(setMaps)
      .catch((e) => setError(errorMessage(e, "Could not list the saved maps.")));
  useEffect(() => {
    void reload();
  }, [kind]);

  async function run(work: () => Promise<void>, failure: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await reload();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  }

  const saveNew = () =>
    run(async () => {
      const map = await api<SavedMap>("/sandbox/saves", {
        method: "POST",
        body: JSON.stringify({ kind, name: name.trim(), data: getData() }),
      });
      setName("");
      onSaved(map);
    }, "Could not save.");

  const download = () => {
    const blob = new Blob([JSON.stringify({ kind, data: getData() }, null, 1)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind === "flow" ? "cash-flow-map" : "maths-nodes"}${current ? `-${current.name}` : ""}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  async function fromFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text()) as {
        kind?: string;
        data?: Record<string, unknown>;
      };
      if (parsed.kind !== kind || !parsed.data || !Array.isArray(parsed.data["nodes"])) {
        setError(
          kind === "flow" ? "That is not a cash-flow map file." : "That is not a maths-nodes file.",
        );
        return;
      }
      onLoad(parsed.data, null);
    } catch {
      setError("That file could not be read.");
    }
  }

  return (
    <Modal
      title={kind === "flow" ? "Saved cash-flow maps" : "Saved maths nodes"}
      onClose={onClose}
      dismissible
    >
      <div className="space-y-4 text-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void saveNew();
          }}
          className="flex items-end gap-2"
        >
          <label className="block flex-1">
            Save what is on screen as
            <input
              value={name}
              maxLength={80}
              autoFocus
              placeholder="My budget, Plan B, …"
              onChange={(e) => setName(e.target.value)}
              className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </form>

        <div>
          <div className="mb-1 font-medium">Saved</div>
          {maps === null ? (
            <Loading lines={2} />
          ) : maps.length === 0 ? (
            <p className="text-slate-500">Nothing saved yet.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {maps.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-2 py-1.5">
                  {renaming?.id === m.id ? (
                    <input
                      aria-label="New name"
                      autoFocus
                      value={renaming.name}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: m.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                        if (e.key === "Enter" && renaming.name.trim()) {
                          void run(async () => {
                            const map = await api<SavedMap>(`/sandbox/saves/${m.id}`, {
                              method: "PUT",
                              body: JSON.stringify({ name: renaming.name.trim() }),
                            });
                            onRenamed(map);
                            setRenaming(null);
                          }, "Could not rename it.");
                        }
                      }}
                      className="flex-1 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800"
                    />
                  ) : (
                    <span className="flex-1 truncate">
                      <span className="font-medium">{m.name}</span>
                      {current?.id === m.id && (
                        <span className="ml-1 text-xs text-blue-600">(loaded)</span>
                      )}
                      <span className="block text-xs text-slate-500">
                        saved {formatDay(m.updatedAt.slice(0, 10))}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    className={buttonClass}
                    onClick={() =>
                      void run(async () => {
                        const loaded = await api<SavedMap & { data: Record<string, unknown> }>(
                          `/sandbox/saves/${m.id}`,
                        );
                        onLoad(loaded.data, loaded);
                      }, "Could not load it.")
                    }
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={buttonClass}
                    onClick={() => setRenaming({ id: m.id, name: m.name })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${m.name}`}
                    className={`${buttonClass} text-red-700 dark:text-red-400`}
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: `Delete “${m.name}”?`,
                        message: "The saved map is removed for good.",
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      void run(async () => {
                        await api(`/sandbox/saves/${m.id}`, { method: "DELETE" });
                        onDeleted(m.id);
                        toast(`Deleted “${m.name}”.`);
                      }, "Could not delete it.");
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <button type="button" className={buttonClass} onClick={download}>
            Download as a file
          </button>
          <button type="button" className={buttonClass} onClick={() => file.current?.click()}>
            Load from a file
          </button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label="Map file"
            onChange={(e) => void fromFile(e)}
          />
          <span className="text-xs text-slate-500">
            Loading replaces what is on screen; save it first if you want to keep it.
          </span>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
