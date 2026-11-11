import { encodeSnapshot } from "../../../backend/src/services/viewer.service";
import type { ViewerNativePlugin } from "../lib/native";
import { toBase64 } from "../lib/snapshot";

export const KEY = new Uint8Array(32).fill(7);
export const KEY_B64URL = Buffer.from(KEY).toString("base64url");
export const DEVICE = "dev-1234";

/** A real snapshot, written by the PC's own code. */
export function makeFile(
  resources: Record<string, unknown>,
  options: { deviceId?: string; key?: Uint8Array; createdAt?: string; today?: string } = {},
): Uint8Array {
  const createdAt = options.createdAt ?? "2026-11-09T12:00:00.000Z";
  return new Uint8Array(
    encodeSnapshot(
      { format: 1, deviceId: options.deviceId ?? DEVICE, createdAt, appVersion: "0.9.1" },
      {
        format: 1,
        createdAt,
        appVersion: "0.9.1",
        today: options.today ?? "2026-11-09",
        resources,
        failed: [],
      },
      Buffer.from(options.key ?? KEY),
    ),
  );
}

export const pairingCode = (file = "pf-viewer-pixel-dev123.snap"): string =>
  JSON.stringify({ pfViewer: 1, deviceId: DEVICE, name: "Pixel", key: KEY_B64URL, file });

/** A phone in memory: what the Android code would do, without prompts. */
export function fakeNative(over: Partial<ViewerNativePlugin> & { file?: Uint8Array | null } = {}) {
  const state = {
    key: null as { deviceId: string; key: string } | null,
    cache: null as string | null,
    file: over.file ?? null,
    unlocks: 0,
  };
  const native: ViewerNativePlugin = {
    scanCode: async () => ({ text: pairingCode() }),
    saveKey: async (o) => {
      state.key = o;
    },
    unlockKey: async () => {
      state.unlocks++;
      if (!state.key) throw new Error("not paired");
      return state.key;
    },
    status: async () => ({ paired: state.key !== null, deviceId: state.key?.deviceId ?? null }),
    pickFile: async () => ({ uri: "content://drive/1", name: "pf-viewer-pixel-dev123.snap" }),
    readFile: async () => {
      if (!state.file) throw new Error("The file is not reachable.");
      return { data: toBase64(state.file) };
    },
    writeCache: async (o) => {
      state.cache = o.data;
    },
    readCache: async () => ({ data: state.cache }),
    forget: async () => {
      state.key = null;
      state.cache = null;
    },
    ...over,
  };
  return { native, state };
}
