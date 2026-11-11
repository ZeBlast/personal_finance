import { registerPlugin, WebPlugin } from "@capacitor/core";
import { fromBase64Url, toBase64 } from "./snapshot";

/**
 * The phone's own features, from the app's Android code (android/app/src/main/java/.../
 * ViewerNativePlugin.java). In a browser (development, tests) a stand-in below is used.
 */
export interface ViewerNativePlugin {
  /** Scans a QR code with Google's code scanner (no camera permission needed). */
  scanCode(): Promise<{ text: string }>;
  /**
   * Keeps the phone's snapshot key, wrapped by an Android Keystore key that needs the phone's
   * fingerprint, face or screen lock to use. Asks for it now.
   */
  saveKey(options: { deviceId: string; key: string }): Promise<void>;
  /** Unwraps the key; asks for the fingerprint, face or screen lock. This is the app lock. */
  unlockKey(): Promise<{ deviceId: string; key: string }>;
  /** Whether a key is kept (no prompt). */
  status(): Promise<{ paired: boolean; deviceId: string | null }>;
  /** Lets the user pick the snapshot file (Google Drive), and keeps access to it. */
  pickFile(): Promise<{ uri: string; name: string }>;
  /** Reads the picked file, base64. */
  readFile(options: { uri: string }): Promise<{ data: string }>;
  /** The last good snapshot, kept in the app's private storage (it stays encrypted). */
  writeCache(options: { data: string }): Promise<void>;
  readCache(): Promise<{ data: string | null }>;
  /** Erases the key, the kept snapshot and the file access. */
  forget(): Promise<void>;
}

const KEY_ITEM = "pf-viewer-web-key";
const CACHE_ITEM = "pf-viewer-web-cache";
const FILE_ITEM = "pf-viewer-web-file";

function stored(item: string): string | null {
  try {
    return localStorage.getItem(item);
  } catch {
    return null;
  }
}

function store(item: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(item);
    else localStorage.setItem(item, value);
  } catch {
    // A browser that refuses storage just forgets.
  }
}

/** The browser stand-in: a prompt for the code, a file input for the file, browser storage. */
export class ViewerNativeWeb extends WebPlugin implements ViewerNativePlugin {
  async scanCode(): Promise<{ text: string }> {
    const text = window.prompt("Paste the pairing code (development only)");
    if (!text) throw new Error("cancelled");
    return { text };
  }

  async saveKey(options: { deviceId: string; key: string }): Promise<void> {
    fromBase64Url(options.key);
    store(KEY_ITEM, JSON.stringify(options));
  }

  async unlockKey(): Promise<{ deviceId: string; key: string }> {
    const value = stored(KEY_ITEM);
    if (!value) throw new Error("not paired");
    return JSON.parse(value) as { deviceId: string; key: string };
  }

  async status(): Promise<{ paired: boolean; deviceId: string | null }> {
    const value = stored(KEY_ITEM);
    return {
      paired: value !== null,
      deviceId: value ? (JSON.parse(value) as { deviceId: string }).deviceId : null,
    };
  }

  pickFile(): Promise<{ uri: string; name: string }> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          reject(new Error("cancelled"));
          return;
        }
        void file.arrayBuffer().then((buffer) => {
          store(FILE_ITEM, toBase64(new Uint8Array(buffer)));
          resolve({ uri: `web:${file.name}`, name: file.name });
        });
      };
      input.click();
    });
  }

  async readFile(): Promise<{ data: string }> {
    const data = stored(FILE_ITEM);
    if (data === null) throw new Error("The file is not reachable.");
    return { data };
  }

  async writeCache(options: { data: string }): Promise<void> {
    store(CACHE_ITEM, options.data);
  }

  async readCache(): Promise<{ data: string | null }> {
    return { data: stored(CACHE_ITEM) };
  }

  async forget(): Promise<void> {
    for (const item of [KEY_ITEM, CACHE_ITEM, FILE_ITEM]) store(item, null);
  }
}

export const ViewerNative = registerPlugin<ViewerNativePlugin>("ViewerNative", {
  web: () => new ViewerNativeWeb(),
});
