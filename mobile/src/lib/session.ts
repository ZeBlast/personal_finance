import { ViewerNative, type ViewerNativePlugin } from "./native";
import { parsePairing } from "./pairing";
import {
  fromBase64,
  fromBase64Url,
  openSnapshot,
  SnapshotError,
  toBase64,
  type Snapshot,
} from "./snapshot";

/** The picked snapshot file (not secret: the key that opens it is in the Keystore). */
export interface PickedFile {
  uri: string;
  name: string;
}

/** Where the app is, start to finish. */
export type Phase =
  | { kind: "starting" }
  | { kind: "unpaired" }
  /** Paired, but no file picked yet (or it must be picked again). */
  | { kind: "needFile"; expectedName: string | null; problem: string | null }
  | { kind: "locked"; problem: string | null }
  | {
      kind: "ready";
      snapshot: Snapshot;
      /** `cache`: the PC's file could not be read, so the last good copy is shown. */
      source: "file" | "cache";
      problem: string | null;
    };

const FILE_ITEM = "pf-viewer-file";
const EXPECTED_ITEM = "pf-viewer-expected-name";

function read(item: string): string | null {
  try {
    return localStorage.getItem(item);
  } catch {
    return null;
  }
}

function write(item: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(item);
    else localStorage.setItem(item, value);
  } catch {
    // Without storage the file is simply picked again next time.
  }
}

export function pickedFile(): PickedFile | null {
  const value = read(FILE_ITEM);
  if (!value) return null;
  try {
    return JSON.parse(value) as PickedFile;
  } catch {
    return null;
  }
}

export const expectedName = (): string | null => read(EXPECTED_ITEM);

const message = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** Native calls refused by the user (back button, cancel) carry this word. */
export const cancelled = (error: unknown): boolean =>
  error instanceof Error && /cancel/i.test(error.message);

/**
 * Everything the screens do, over the native plugin (replaceable in tests). The key is held in
 * memory only while the app is open; it is unwrapped again, with the phone's lock, next time.
 */
export function createSession(native: ViewerNativePlugin = ViewerNative) {
  let key: { deviceId: string; bytes: Uint8Array } | null = null;

  return {
    /** Where to begin: paired or not, file picked or not. Never prompts. */
    async start(): Promise<Phase> {
      const status = await native.status();
      if (!status.paired) return { kind: "unpaired" };
      if (!pickedFile()) return { kind: "needFile", expectedName: expectedName(), problem: null };
      return { kind: "locked", problem: null };
    },

    /** Scans the PC's code and keeps its key (asks for the phone's lock). */
    async pair(): Promise<Phase> {
      const { text } = await native.scanCode();
      const pairing = parsePairing(text);
      if (!pairing) {
        throw new Error("That is not a Finance pairing code. Scan the code the PC shows.");
      }
      await native.saveKey({ deviceId: pairing.deviceId, key: pairing.key });
      key = { deviceId: pairing.deviceId, bytes: fromBase64Url(pairing.key) };
      write(EXPECTED_ITEM, pairing.file);
      write(FILE_ITEM, null);
      return { kind: "needFile", expectedName: pairing.file, problem: null };
    },

    /** Picks the snapshot file, then opens it. */
    async pick(): Promise<Phase> {
      const file = await native.pickFile();
      write(FILE_ITEM, JSON.stringify(file));
      return this.load();
    },

    /** Unlocks the key if needed, then reads the PC's file (or the last good copy). */
    async load(): Promise<Phase> {
      if (!key) {
        const unlocked = await native.unlockKey();
        key = { deviceId: unlocked.deviceId, bytes: fromBase64Url(unlocked.key) };
      }
      const file = pickedFile();
      let problem: string | null = null;
      if (file) {
        try {
          const { data } = await native.readFile({ uri: file.uri });
          const bytes = fromBase64(data);
          const snapshot = await openSnapshot(bytes, key.bytes, key.deviceId);
          await native.writeCache({ data: toBase64(bytes) }).catch(() => undefined);
          return { kind: "ready", snapshot, source: "file", problem: null };
        } catch (error) {
          problem =
            error instanceof SnapshotError
              ? error.message
              : `Could not read ${file.name} (${message(error, "unknown error")}).`;
          // A wrong file or a refused key will not get better from the copy: pick again.
          if (error instanceof SnapshotError && error.code !== "damaged") {
            return { kind: "needFile", expectedName: expectedName(), problem };
          }
        }
      }
      const { data } = await native.readCache();
      if (data) {
        try {
          const snapshot = await openSnapshot(fromBase64(data), key.bytes, key.deviceId);
          return { kind: "ready", snapshot, source: "cache", problem };
        } catch {
          // Fall through: nothing readable.
        }
      }
      return {
        kind: "needFile",
        expectedName: expectedName(),
        problem: problem ?? "Pick the snapshot file in Google Drive.",
      };
    },

    /** Forgets everything on this phone. */
    async forget(): Promise<Phase> {
      await native.forget();
      key = null;
      write(FILE_ITEM, null);
      write(EXPECTED_ITEM, null);
      return { kind: "unpaired" };
    },

    /** Drops the key from memory (the app went to the background for a while). */
    lock(): void {
      key = null;
    },
  };
}

export type Session = ReturnType<typeof createSession>;
