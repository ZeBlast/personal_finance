import qrcode from "qrcode-generator";
import { useMemo, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../common/styles";

export interface ViewerDevice {
  id: number;
  deviceId: string;
  name: string;
  folder: string;
  file: string;
  pairedAt: string;
  lastWrittenAt: string | null;
  lastError: string | null;
}

interface DeviceList {
  devices: ViewerDevice[];
  suggestedFolder: string | null;
}

interface Pairing {
  device: ViewerDevice;
  pairing: { pfViewer: number; deviceId: string; name: string; key: string; file: string };
}

interface WriteResult {
  written: number[];
  failed: Array<{ id: number; reason: string }>;
}

const when = (iso: string): string => new Date(iso).toLocaleString();

/** The dark squares of a QR code for `text`, drawn as SVG (no HTML strings). */
export function qrModules(text: string): { size: number; dark: Array<[number, number]> } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark: Array<[number, number]> = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (qr.isDark(row, col)) dark.push([col, row]);
  }
  return { size, dark };
}

function QrCode({ text, label }: { text: string; label: string }) {
  const { size, dark } = useMemo(() => qrModules(text), [text]);
  const quiet = 4; // the blank border scanners need
  const path = dark.map(([x, y]) => `M${x + quiet} ${y + quiet}h1v1h-1z`).join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size + 2 * quiet} ${size + 2 * quiet}`}
      className="h-64 w-64 rounded bg-white"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Shows a new phone's pairing code once. Closing it loses the key for good (pair again if lost). */
function PairingDialog({ paired, onClose }: { paired: Pairing; onClose: () => void }) {
  const text = JSON.stringify(paired.pairing);
  return (
    <Modal title={`Pair ${paired.device.name}`} onClose={onClose} dismissible={false}>
      <div className="space-y-3 text-sm">
        <p>
          Open the Personal Finance viewer on the phone, choose <strong>Pair with PC</strong>, and
          scan this code. Then pick <code>{paired.pairing.file}</code> in Google Drive.
        </p>
        <div className="flex justify-center">
          <QrCode text={text} label={`Pairing code for ${paired.device.name}`} />
        </div>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          The code holds the key that opens this phone&apos;s snapshots, and it is shown only now.
          Do not photograph or share it. If you close this before scanning, forget the phone and
          pair it again.
        </p>
        <div className="flex justify-end">
          <button type="button" className={primaryClass} onClick={onClose}>
            Done, it is scanned
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PairForm({
  suggestedFolder,
  onPaired,
}: {
  suggestedFolder: string | null;
  onPaired: (p: Pairing) => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownFolder = folder ?? suggestedFolder ?? "";

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const paired = await api<Pairing>("/viewer/devices", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), folder: shownFolder.trim() }),
      });
      setName("");
      setFolder(null);
      onPaired(paired);
    } catch (e) {
      setError(errorMessage(e, "Could not pair the phone."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2 text-sm">
      <h3 className="font-medium">Pair a phone</h3>
      <label className="block">
        Phone name
        <input
          className={inputClass}
          value={name}
          maxLength={60}
          placeholder="Pixel"
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="block">
        Folder that syncs to the phone
        <input
          className={inputClass}
          value={shownFolder}
          maxLength={500}
          placeholder="G:\My Drive\Personal Finance Viewer"
          onChange={(e) => setFolder(e.target.value)}
          required
        />
        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          A folder in Google Drive for desktop works well. It is created if needed. Only encrypted
          files are written there.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <button type="submit" className={primaryClass} disabled={busy || name.trim() === ""}>
        {busy ? "Working..." : "Pair and show the code"}
      </button>
    </form>
  );
}

function DeviceRow({
  device,
  onForget,
  onChanged,
}: {
  device: ViewerDevice;
  onForget: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [folder, setFolder] = useState(device.folder);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await api(`/viewer/devices/${device.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), folder: folder.trim() }),
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <li className="space-y-1 rounded border border-slate-200 p-3 text-sm dark:border-slate-700">
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="space-y-2">
          <label className="block">
            Phone name
            <input
              className={inputClass}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            Folder
            <input
              className={inputClass}
              value={folder}
              maxLength={500}
              onChange={(e) => setFolder(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={primaryClass}>
              Save
            </button>
            <button type="button" className={buttonClass} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{device.name}</span>
            <span className="flex gap-2">
              <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
                Rename or move
              </button>
              <button type="button" className={buttonClass} onClick={onForget}>
                Forget
              </button>
            </span>
          </div>
          <p className="break-all text-slate-500 dark:text-slate-400">{device.file}</p>
          <p>
            {device.lastWrittenAt
              ? `Last written ${when(device.lastWrittenAt)}`
              : "Not written yet"}
          </p>
        </>
      )}
      {device.lastError && (
        <p role="alert" className="text-red-600">
          {device.lastError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Settings for the phone viewer: a read-only copy of the app for an Android phone. The app writes
 * an encrypted snapshot for each paired phone after every sync; the phone reads it from a synced
 * folder. No bank connection, Plaid key or recovery key ever goes to the phone.
 */
export function PhoneViewerPanel() {
  const list = useApi<DeviceList>("/viewer/devices");
  const [paired, setPaired] = useState<Pairing | null>(null);
  const [forgetting, setForgetting] = useState<ViewerDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const devices = list.data?.devices ?? [];

  async function writeNow(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<WriteResult>("/viewer/write", { method: "POST" });
      setNotice(
        result.failed.length > 0
          ? { kind: "error", text: result.failed.map((f) => f.reason).join(" ") }
          : { kind: "info", text: `Written for ${result.written.length} phone(s).` },
      );
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not write the snapshots.") });
    } finally {
      setBusy(false);
      list.reload();
    }
  }

  async function forget(device: ViewerDevice): Promise<void> {
    setBusy(true);
    try {
      await api(`/viewer/devices/${device.id}`, { method: "DELETE" });
      setNotice({ kind: "info", text: `${device.name} is forgotten.` });
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not forget that phone.") });
    } finally {
      setBusy(false);
      setForgetting(null);
      list.reload();
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div>
        <h2 className="text-lg font-semibold">Phone viewer</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          See your accounts, spending and plans on an Android phone, read-only. After each sync,
          this computer writes an encrypted copy into a folder that syncs to the phone. Your bank
          connections and Plaid keys never leave this computer.
        </p>
      </div>
      {list.error && (
        <p role="alert" className="text-sm text-red-600">
          {list.error}
        </p>
      )}
      {devices.length > 0 && (
        <>
          <ul className="space-y-2">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                onForget={() => setForgetting(d)}
                onChanged={list.reload}
              />
            ))}
          </ul>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void writeNow()}
          >
            {busy ? "Working..." : "Write now"}
          </button>
        </>
      )}
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`text-sm ${notice.kind === "error" ? "text-red-600" : "text-green-800 dark:text-green-300"}`}
        >
          {notice.text}
        </p>
      )}
      {list.data && (
        <PairForm
          suggestedFolder={list.data.suggestedFolder}
          onPaired={(p) => {
            setPaired(p);
            list.reload();
          }}
        />
      )}
      {paired && <PairingDialog paired={paired} onClose={() => setPaired(null)} />}
      {forgetting && (
        <ConfirmDialog
          title={`Forget ${forgetting.name}?`}
          message="Nothing new is written for this phone, and its file is deleted from the folder. The copy already on the phone stays until you reset the viewer app there."
          confirmLabel="Forget"
          danger
          busy={busy}
          onConfirm={() => void forget(forgetting)}
          onCancel={() => setForgetting(null)}
        />
      )}
    </section>
  );
}
