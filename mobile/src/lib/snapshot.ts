/**
 * Reads a snapshot file written by the Windows app (backend/src/services/viewer.service.ts):
 *
 *   "PFV1" | header length (uint32, big-endian) | header (JSON) | IV (12) | tag (16) | body
 *
 * Everything before the IV is the AES-GCM associated data; the body is gzip-compressed JSON
 * encrypted with AES-256-GCM. Uses only the browser's own WebCrypto and DecompressionStream, which
 * the Android WebView has.
 */

export const SNAPSHOT_FORMAT = 1;
const MAGIC = [0x50, 0x46, 0x56, 0x31]; // "PFV1"
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SnapshotHeader {
  format: number;
  deviceId: string;
  createdAt: string;
  appVersion: string;
}

export interface SnapshotBody {
  format: number;
  createdAt: string;
  appVersion: string;
  /** The PC's local day when it was written (`YYYY-MM-DD`). */
  today: string;
  /** API responses keyed by the request path the app's own screens use. */
  resources: Record<string, unknown>;
  failed: string[];
}

export interface Snapshot {
  header: SnapshotHeader;
  body: SnapshotBody;
}

export class SnapshotError extends Error {
  constructor(
    readonly code: "not_snapshot" | "unsupported" | "wrong_key" | "wrong_phone" | "damaged",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** The readable header, without the key. */
export function readHeader(file: Uint8Array): { header: SnapshotHeader; bodyStart: number } {
  if (file.length < 8 || MAGIC.some((b, i) => file[i] !== b)) {
    throw new SnapshotError("not_snapshot", "That file is not a Finance Viewer snapshot.");
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const length = view.getUint32(4, false);
  const bodyStart = 8 + length;
  if (length > 64 * 1024 || file.length < bodyStart + IV_BYTES + TAG_BYTES) {
    throw new SnapshotError("damaged", "The snapshot file is incomplete.");
  }
  let header: SnapshotHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(file.subarray(8, bodyStart))) as SnapshotHeader;
  } catch {
    throw new SnapshotError("damaged", "The snapshot file is damaged.");
  }
  if (header.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotError(
      "unsupported",
      "This snapshot is from a newer version of the PC app. Update this app.",
    );
  }
  return { header, bodyStart };
}

/** A copy that WebCrypto accepts as BufferSource whatever the source buffer is. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(own(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decrypts a snapshot with this phone's key. `deviceId`, when given, must match the header: a
 * file written for another phone is refused even before trying the key.
 */
export async function openSnapshot(
  file: Uint8Array,
  key: Uint8Array,
  deviceId?: string,
): Promise<Snapshot> {
  const { header, bodyStart } = readHeader(file);
  if (deviceId !== undefined && header.deviceId !== deviceId) {
    throw new SnapshotError(
      "wrong_phone",
      "That snapshot was written for another phone. Pick this phone's file.",
    );
  }
  const iv = file.subarray(bodyStart, bodyStart + IV_BYTES);
  const tag = file.subarray(bodyStart + IV_BYTES, bodyStart + IV_BYTES + TAG_BYTES);
  const encrypted = file.subarray(bodyStart + IV_BYTES + TAG_BYTES);
  // WebCrypto wants the tag at the end of the ciphertext.
  const sealed = new Uint8Array(encrypted.length + TAG_BYTES);
  sealed.set(encrypted);
  sealed.set(tag, encrypted.length);
  let compressed: Uint8Array;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", own(key), "AES-GCM", false, ["decrypt"]);
    compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: own(iv),
          additionalData: own(file.subarray(0, bodyStart)),
          tagLength: 128,
        },
        cryptoKey,
        sealed,
      ),
    );
  } catch {
    throw new SnapshotError(
      "wrong_key",
      "The snapshot could not be opened with this phone's key. Pair again if the PC forgot this phone.",
    );
  }
  let body: SnapshotBody;
  try {
    body = JSON.parse(new TextDecoder().decode(await gunzip(compressed))) as SnapshotBody;
  } catch {
    throw new SnapshotError("damaged", "The snapshot file is damaged.");
  }
  return { header, body };
}

/** base64url (no padding), as the pairing code writes the key. */
export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}
