import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { and, eq, isNull } from "drizzle-orm";
import { viewerDevices } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import type { TokenCipher } from "./crypto.js";

/**
 * The phone viewer: a read-only copy of the app for an Android phone.
 *
 * After each sync (and once edits settle) the app asks its own API for the views the phone shows,
 * exactly as the window would, and writes them as ONE encrypted file per paired phone into a folder
 * that reaches the phone (a Google Drive folder, say). The phone got its key once, from a QR code
 * shown here, so the folder (and whoever hosts it) only ever holds ciphertext. Nothing in the file
 * can reach a bank: no Plaid keys, access tokens or recovery key are ever part of it.
 *
 * File layout (all of it authenticated, the body encrypted):
 *
 *   "PFV1" | header length (uint32, big-endian) | header (JSON) | IV (12) | tag (16) | body
 *
 * The header (format, device ID, when, app version) is readable, so the phone can tell the file is
 * its own and how old it is before decrypting; it is the AES-GCM associated data, so it cannot be
 * changed or swapped. The body is gzip-compressed JSON, encrypted with AES-256-GCM.
 */

export const SNAPSHOT_FORMAT = 1;
const MAGIC = Buffer.from("PFV1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A body larger than this (compressed) is refused rather than written: something is wrong. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** How many months of transactions and monthly reports the phone gets. */
export const HISTORY_MONTHS = 13;
/** How far ahead the phone's upcoming list and cash forecast look. */
export const UPCOMING_DAYS = 60;
export const FORECAST_DAYS = 90;
/** The most transactions a snapshot carries, whatever the dates say. */
const MAX_TRANSACTIONS = 20_000;
const TRANSACTION_PAGE = 200;
/** After an edit, wait this long for more before writing (a burst of edits writes once). */
export const EDIT_SETTLE_MS = 60_000;
/** After a sync, wait briefly so several connections syncing in a row write once. */
export const SYNC_SETTLE_MS = 5_000;

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
  /** The local day the snapshot was made for (`YYYY-MM-DD`): "this month", "upcoming" count from it. */
  today: string;
  /**
   * API responses, keyed by the request path exactly as the app's own screens ask for it, so the
   * phone can reuse the same components with a lookup in place of HTTP.
   */
  resources: Record<string, unknown>;
  /** Paths that could not be read this time (the phone shows those screens as unavailable). */
  failed: string[];
}

export interface ViewerDeviceDto {
  id: number;
  deviceId: string;
  name: string;
  folder: string;
  /** The snapshot file's full path. */
  file: string;
  pairedAt: string;
  lastWrittenAt: string | null;
  lastError: string | null;
}

/** What the QR code carries: everything the phone needs, once. */
export interface PairingPayload {
  pfViewer: number;
  deviceId: string;
  name: string;
  /** The 32-byte snapshot key, base64url. */
  key: string;
  /** The snapshot file's name, so the phone can find it in the folder. */
  file: string;
}

/** Reads one API path the way the app's screens do. */
export type ApiGet = (path: string) => Promise<unknown>;

// ---------------------------------------------------------------------------------------------
// The file format

export function encodeSnapshot(header: SnapshotHeader, body: SnapshotBody, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("A snapshot key is 32 bytes");
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const aad = Buffer.concat([MAGIC, length, headerBytes]);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
  if (compressed.length > MAX_BODY_BYTES) {
    throw new AppError(
      500,
      "snapshot_too_large",
      "The phone snapshot came out too large to write.",
    );
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), encrypted]);
}

/** The readable header, without the key. Throws when the file is not a snapshot. */
export function readSnapshotHeader(file: Buffer): { header: SnapshotHeader; bodyStart: number } {
  if (file.length < MAGIC.length + 4 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a phone viewer snapshot");
  }
  const length = file.readUInt32BE(MAGIC.length);
  const bodyStart = MAGIC.length + 4 + length;
  if (length > 64 * 1024 || file.length < bodyStart + IV_BYTES + TAG_BYTES) {
    throw new Error("The snapshot is truncated");
  }
  const header = JSON.parse(
    file.subarray(MAGIC.length + 4, bodyStart).toString("utf8"),
  ) as SnapshotHeader;
  if (header.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Snapshot format ${String(header.format)} is not supported`);
  }
  return { header, bodyStart };
}

export function decodeSnapshot(
  file: Buffer,
  key: Buffer,
): { header: SnapshotHeader; body: SnapshotBody } {
  const { header, bodyStart } = readSnapshotHeader(file);
  const aad = file.subarray(0, bodyStart);
  const iv = file.subarray(bodyStart, bodyStart + IV_BYTES);
  const tag = file.subarray(bodyStart + IV_BYTES, bodyStart + IV_BYTES + TAG_BYTES);
  const encrypted = file.subarray(bodyStart + IV_BYTES + TAG_BYTES);
  let compressed: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    // Deliberately vague, as for tokens: wrong key and changed file look the same.
    throw new Error("Could not decrypt the snapshot (wrong key or changed file)");
  }
  return { header, body: JSON.parse(zlib.gunzipSync(compressed).toString("utf8")) as SnapshotBody };
}

export const encodeKey = (key: Buffer): string => key.toString("base64url");

export function decodeKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length !== 32) throw new Error("A viewer key is 32 bytes, written as 43 characters");
  return key;
}

/** `pf-viewer-<name>-<first 6 of the ID>.snap`, safe on Windows and in Google Drive. */
export function snapshotFileName(name: string, deviceId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "phone";
  return `pf-viewer-${slug}-${deviceId.replace(/-/g, "").slice(0, 6)}.snap`;
}

/** Replaces the file in one step, so the phone (or Drive) never sees half of it. */
function writeAtomically(file: string, data: Buffer): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// What goes in

function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDaysTo(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The `count` months ending with `day`'s month, oldest first. */
function monthsEnding(day: string, count: number): string[] {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(year, month - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** The single-request views the phone shows (transactions are paged separately). */
export function snapshotPaths(today: string): string[] {
  const month = today.slice(0, 7);
  const months = monthsEnding(today, HISTORY_MONTHS);
  return [
    "/settings",
    "/accounts",
    "/institutions",
    "/categories",
    "/tags",
    "/sync/status",
    `/brief?bufferMinor=0`,
    "/analytics/overview",
    `/analytics/net-worth-series?granularity=month&from=${addDaysTo(today, -730)}`,
    `/budgets?month=${month}&today=${today}`,
    `/forecast?days=${FORECAST_DAYS}&today=${today}`,
    `/calendar/expected?from=${today}&to=${addDaysTo(today, UPCOMING_DAYS)}`,
    "/bills",
    "/paychecks",
    "/subscriptions",
    "/tracked-subscriptions",
    "/renewals",
    "/goals",
    "/debt",
    "/investments/overview",
    "/investments/holdings",
    "/investments/returns",
    ...months.map((m) => `/reports/month?month=${m}`),
  ];
}

/** The `/transactions` key in a snapshot: every transaction from `from` to `to`, in one page. */
export const transactionsPath = (from: string, to: string): string =>
  `/transactions?from=${from}&to=${to}`;

interface TransactionPage {
  items: unknown[];
  total: number;
}

async function readTransactions(get: ApiGet, from: string, to: string) {
  const items: unknown[] = [];
  let total = 0;
  for (let page = 1; items.length < MAX_TRANSACTIONS; page++) {
    const result = (await get(
      `/transactions?from=${from}&to=${to}&pageSize=${TRANSACTION_PAGE}&page=${page}`,
    )) as TransactionPage;
    total = result.total;
    items.push(...result.items);
    if (result.items.length < TRANSACTION_PAGE || items.length >= total) break;
  }
  const kept = items.slice(0, MAX_TRANSACTIONS);
  return { items: kept, total: Math.min(total, MAX_TRANSACTIONS), page: 1, pageSize: kept.length };
}

/** Collects every view the phone shows. A view that fails is listed, not fatal. */
export async function buildSnapshotBody(
  get: ApiGet,
  options: { now: Date; appVersion: string },
): Promise<SnapshotBody> {
  const today = localDay(options.now);
  const resources: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const p of snapshotPaths(today)) {
    try {
      resources[p] = await get(p);
    } catch {
      failed.push(p);
    }
  }
  const from = `${monthsEnding(today, HISTORY_MONTHS)[0]!}-01`;
  const txPath = transactionsPath(from, today);
  try {
    resources[txPath] = await readTransactions(get, from, today);
  } catch {
    failed.push(txPath);
  }
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: options.now.toISOString(),
    appVersion: options.appVersion,
    today,
    resources,
    failed,
  };
}

// ---------------------------------------------------------------------------------------------
// Paired phones

type DeviceRow = typeof viewerDevices.$inferSelect;

const keyContext = (deviceId: string): string => `viewer-device:${deviceId}`;

function toDto(row: DeviceRow): ViewerDeviceDto {
  return {
    id: row.id,
    deviceId: row.deviceId,
    name: row.name,
    folder: row.folder,
    file: path.join(row.folder, snapshotFileName(row.name, row.deviceId)),
    pairedAt: row.pairedAt,
    lastWrittenAt: row.lastWrittenAt,
    lastError: row.lastError,
  };
}

/** Checks a folder typed by the user: an absolute path whose parent exists. Creates the folder. */
export function prepareFolder(folder: string): string {
  const resolved = folder.trim();
  if (!path.isAbsolute(resolved)) {
    throw new AppError(
      400,
      "invalid_folder",
      "Give the folder's full path, such as G:\\My Drive\\Finance.",
    );
  }
  if (!fs.existsSync(path.dirname(resolved))) {
    throw new AppError(400, "folder_not_found", `${path.dirname(resolved)} does not exist.`);
  }
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    throw new AppError(400, "folder_not_writable", "That folder could not be created.");
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new AppError(400, "invalid_folder", "That path is a file, not a folder.");
  }
  return resolved;
}

/**
 * Where Google Drive for desktop puts "My Drive" on this computer, if it is there: a drive letter
 * (G: by default) or a folder in the user's home. Null when none is found.
 */
export function suggestFolder(
  exists: (p: string) => boolean = fs.existsSync,
  home: string = os.homedir(),
  windows: boolean = process.platform === "win32",
): string | null {
  const join = windows ? path.win32.join : path.join;
  const candidates: string[] = [];
  if (windows) {
    for (const letter of "GHIJKLMNOPQRSTUVWXYZDEF") candidates.push(`${letter}:\\My Drive`);
  }
  candidates.push(join(home, "Google Drive", "My Drive"), join(home, "My Drive"));
  const found = candidates.find((c) => exists(c));
  return found ? join(found, "Personal Finance Viewer") : null;
}

interface Deps {
  db: AppDb;
  cipher: TokenCipher;
  appVersion: string;
  /** Reads the app's own API; the server reads it over loopback, tests in-process. */
  get: ApiGet;
  now?: () => Date;
}

export function createViewerService({ db, cipher, appVersion, get, now = () => new Date() }: Deps) {
  let timer: NodeJS.Timeout | null = null;
  let timerDue = 0;
  let running: Promise<WriteResult> | null = null;
  let queued: Promise<WriteResult> | null = null;

  function activeRows(): DeviceRow[] {
    return db.select().from(viewerDevices).where(isNull(viewerDevices.revokedAt)).all();
  }

  function requireDevice(id: number): DeviceRow {
    const row = db
      .select()
      .from(viewerDevices)
      .where(and(eq(viewerDevices.id, id), isNull(viewerDevices.revokedAt)))
      .get();
    if (!row) throw notFound("That phone");
    return row;
  }

  function cleanName(name: string): string {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 60) {
      throw new AppError(400, "invalid_name", "Give the phone a name of up to 60 characters.");
    }
    return trimmed;
  }

  async function writeNow(): Promise<WriteResult> {
    if (activeRows().length === 0) return { written: [], failed: [] };
    const at = now();
    const body = await buildSnapshotBody(get, { now: at, appVersion });
    const result: WriteResult = { written: [], failed: [] };
    // Read the phones again after the (slow) collection: one renamed, moved or forgotten
    // meanwhile is written as it is now, or not at all.
    for (const row of activeRows()) {
      const file = path.join(row.folder, snapshotFileName(row.name, row.deviceId));
      try {
        const key = Buffer.from(cipher.decrypt(row.keyEncrypted, keyContext(row.deviceId)), "hex");
        const header: SnapshotHeader = {
          format: SNAPSHOT_FORMAT,
          deviceId: row.deviceId,
          createdAt: body.createdAt,
          appVersion,
        };
        fs.mkdirSync(row.folder, { recursive: true });
        writeAtomically(file, encodeSnapshot(header, body, key));
        db.update(viewerDevices)
          .set({ lastWrittenAt: body.createdAt, lastError: null })
          .where(eq(viewerDevices.id, row.id))
          .run();
        result.written.push(row.id);
      } catch (error) {
        // A short, safe reason only: the folder, never the key or the data.
        const reason =
          error instanceof AppError
            ? error.message
            : `Could not write to ${row.folder} (${(error as NodeJS.ErrnoException).code ?? "error"}).`;
        db.update(viewerDevices)
          .set({ lastError: reason })
          .where(eq(viewerDevices.id, row.id))
          .run();
        result.failed.push({ id: row.id, reason });
      }
    }
    return result;
  }

  /**
   * One write at a time. A request during a write waits for ONE more write that starts after the
   * current one, so whoever asks always gets a snapshot made after they asked.
   */
  function runWrite(): Promise<WriteResult> {
    if (!running) {
      running = writeNow().finally(() => {
        running = null;
      });
      return running;
    }
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return runWrite();
      });
    return queued;
  }

  return {
    list(): ViewerDeviceDto[] {
      return activeRows().map(toDto);
    },

    /** Pairs a phone: makes its key, and returns it ONCE, for the QR code. */
    pair(input: { name: string; folder: string }): {
      device: ViewerDeviceDto;
      pairing: PairingPayload;
    } {
      const name = cleanName(input.name);
      const folder = prepareFolder(input.folder);
      const deviceId = crypto.randomUUID();
      const key = crypto.randomBytes(32);
      const row = db
        .insert(viewerDevices)
        .values({
          deviceId,
          name,
          folder,
          keyEncrypted: cipher.encrypt(key.toString("hex"), keyContext(deviceId)),
          pairedAt: now().toISOString(),
        })
        .returning()
        .get();
      return {
        device: toDto(row),
        pairing: {
          pfViewer: SNAPSHOT_FORMAT,
          deviceId,
          name,
          key: encodeKey(key),
          file: snapshotFileName(name, deviceId),
        },
      };
    },

    /** Renames a phone or moves its folder; the old file is removed so only one copy is kept. */
    update(id: number, input: { name?: string | undefined; folder?: string | undefined }) {
      const row = requireDevice(id);
      const name = input.name === undefined ? row.name : cleanName(input.name);
      const folder = input.folder === undefined ? row.folder : prepareFolder(input.folder);
      const before = path.join(row.folder, snapshotFileName(row.name, row.deviceId));
      const after = path.join(folder, snapshotFileName(name, row.deviceId));
      db.update(viewerDevices).set({ name, folder }).where(eq(viewerDevices.id, id)).run();
      if (before !== after) fs.rmSync(before, { force: true });
      return toDto(requireDevice(id));
    },

    /**
     * Forgets a phone: nothing is written for it again, its file is deleted from the folder, and
     * its key is erased here. The copy already on the phone stays until the phone's app is reset.
     */
    revoke(id: number): void {
      const row = requireDevice(id);
      db.update(viewerDevices)
        .set({ revokedAt: now().toISOString(), keyEncrypted: "" })
        .where(eq(viewerDevices.id, id))
        .run();
      fs.rmSync(path.join(row.folder, snapshotFileName(row.name, row.deviceId)), { force: true });
    },

    /** Writes every phone's snapshot now (the Write now button), joining a write under way. */
    writeAll: runWrite,

    /**
     * Asks for a write after `delayMs`. An earlier deadline wins, so a sync after an edit writes
     * soon; does nothing when no phone is paired.
     */
    scheduleWrite(delayMs: number): void {
      if (activeRows().length === 0) return;
      const due = Date.now() + delayMs;
      if (timer && timerDue <= due) return;
      if (timer) clearTimeout(timer);
      timerDue = due;
      timer = setTimeout(() => {
        timer = null;
        runWrite().catch((error: unknown) =>
          console.error(
            "phone snapshot failed:",
            error instanceof Error ? error.message : "unknown error",
          ),
        );
      }, delayMs);
      timer.unref();
    },

    /** Stops a pending write (tests, shutdown). */
    cancelScheduled(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface WriteResult {
  written: number[];
  failed: Array<{ id: number; reason: string }>;
}

export type ViewerService = ReturnType<typeof createViewerService>;
