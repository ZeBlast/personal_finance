import { fromBase64Url } from "./snapshot";

/** What the PC's pairing QR code carries (backend PairingPayload). */
export interface Pairing {
  deviceId: string;
  name: string;
  /** The 32-byte snapshot key, base64url. */
  key: string;
  /** The snapshot's file name, to look for in Google Drive. */
  file: string;
}

/** Reads a scanned code. Returns null when it is not a Finance pairing code. */
export function parsePairing(text: string): Pairing | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    v["pfViewer"] !== 1 ||
    typeof v["deviceId"] !== "string" ||
    typeof v["name"] !== "string" ||
    typeof v["key"] !== "string" ||
    typeof v["file"] !== "string"
  ) {
    return null;
  }
  try {
    if (fromBase64Url(v["key"]).length !== 32) return null;
  } catch {
    return null;
  }
  return { deviceId: v["deviceId"], name: v["name"], key: v["key"], file: v["file"] };
}
