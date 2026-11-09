import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plaidItems, viewerDevices } from "../../drizzle/schema.js";
import {
  decodeKey,
  decodeSnapshot,
  encodeSnapshot,
  readSnapshotHeader,
  snapshotFileName,
  suggestFolder,
  SNAPSHOT_FORMAT,
  type PairingPayload,
  type SnapshotBody,
  type ViewerDeviceDto,
} from "./services/viewer.service.js";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-viewer-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A test app whose phone viewer reads the API in-process, as the server does over loopback. */
function makeViewerApp() {
  const late: { call?: ReturnType<typeof makeTestApp>["call"] } = {};
  const ctx = makeTestApp({
    viewerGet: async (p) => {
      const res = await late.call!("get", `/api${p}`);
      if (res.status >= 400) throw new Error(`${p} answered ${res.status}`);
      return res.body as unknown;
    },
  });
  late.call = ctx.call;
  cleanups.push(() => ctx.cleanup());
  return ctx;
}

const body = (resources: Record<string, unknown> = {}): SnapshotBody => ({
  format: SNAPSHOT_FORMAT,
  createdAt: "2026-11-09T12:00:00.000Z",
  appVersion: "test",
  today: "2026-11-09",
  resources,
  failed: [],
});

const header = {
  format: SNAPSHOT_FORMAT,
  deviceId: "d1",
  createdAt: "2026-11-09T12:00:00.000Z",
  appVersion: "test",
};

describe("the snapshot file", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips, and its header is readable without the key", () => {
    const file = encodeSnapshot(header, body({ "/accounts": [{ name: "Checking" }] }), key);
    expect(readSnapshotHeader(file).header).toEqual(header);
    const decoded = decodeSnapshot(file, key);
    expect(decoded.header).toEqual(header);
    expect(decoded.body.resources["/accounts"]).toEqual([{ name: "Checking" }]);
  });

  it("holds no readable data", () => {
    const file = encodeSnapshot(header, body({ "/accounts": [{ name: "Distinctive Name" }] }), key);
    expect(file.includes(Buffer.from("Distinctive Name"))).toBe(false);
  });

  it("refuses the wrong key", () => {
    const file = encodeSnapshot(header, body(), key);
    expect(() => decodeSnapshot(file, Buffer.alloc(32, 8))).toThrow(/Could not decrypt/);
  });

  it("refuses a changed header or body", () => {
    const file = encodeSnapshot(header, body(), key);
    const swapped = Buffer.from(file.toString("latin1").replace('"d1"', '"d2"'), "latin1");
    expect(() => decodeSnapshot(swapped, key)).toThrow(/Could not decrypt/);
    const flipped = Buffer.from(file);
    flipped.writeUInt8(flipped.readUInt8(flipped.length - 1) ^ 1, flipped.length - 1);
    expect(() => decodeSnapshot(flipped, key)).toThrow(/Could not decrypt/);
  });

  it("refuses something that is not a snapshot", () => {
    expect(() => readSnapshotHeader(Buffer.from("hello world, not a snapshot"))).toThrow(
      /Not a phone viewer snapshot/,
    );
  });

  it("names the file after the phone, safely", () => {
    expect(snapshotFileName("Jon's Pixel 9!", "ab12cd34-0000")).toBe(
      "pf-viewer-jon-s-pixel-9-ab12cd.snap",
    );
    expect(snapshotFileName("???", "ffffff00")).toBe("pf-viewer-phone-ffffff.snap");
  });
});

describe("suggesting a Google Drive folder", () => {
  it("finds My Drive on a drive letter on Windows", () => {
    const found = suggestFolder((p) => p === "H:\\My Drive", "C:\\Users\\jon", true);
    expect(found).toBe("H:\\My Drive\\Personal Finance Viewer");
  });

  it("is null when there is no Google Drive", () => {
    expect(suggestFolder(() => false, "/home/jon", false)).toBeNull();
  });
});

describe("pairing a phone", () => {
  it("returns the key once, keeps it encrypted, and lists the phone without it", async () => {
    const { call, db } = makeViewerApp();
    const folder = path.join(tempDir(), "Viewer");
    const res = await call("post", "/api/viewer/devices")
      .send({ name: "Pixel", folder })
      .expect(201);
    const pairing = res.body.pairing as PairingPayload;
    expect(pairing.pfViewer).toBe(1);
    expect(decodeKey(pairing.key)).toHaveLength(32);
    expect(fs.existsSync(folder)).toBe(true);

    const stored = db.select().from(viewerDevices).get()!;
    expect(stored.keyEncrypted).not.toContain(decodeKey(pairing.key).toString("hex"));

    const list = await call("get", "/api/viewer/devices").expect(200);
    const devices = list.body.devices as ViewerDeviceDto[];
    expect(devices).toHaveLength(1);
    expect(devices[0]!.name).toBe("Pixel");
    expect(JSON.stringify(list.body)).not.toContain(pairing.key);
  });

  it("refuses a folder that is not a full path", async () => {
    const { call } = makeViewerApp();
    const res = await call("post", "/api/viewer/devices")
      .send({ name: "Pixel", folder: "relative/folder" })
      .expect(400);
    expect(res.body.error).toBe("invalid_folder");
  });
});

describe("writing snapshots", () => {
  it("writes the phone's views, readable only with its key, and never a bank credential", async () => {
    const { call, db, cipher } = makeViewerApp();
    await linkDemoBank(call);
    await call("post", "/api/sync").send({}).expect(200);
    const folder = tempDir();
    const paired = await call("post", "/api/viewer/devices")
      .send({ name: "Pixel", folder })
      .expect(201);
    const pairing = paired.body.pairing as PairingPayload;

    const res = await call("post", "/api/viewer/write").expect(200);
    expect(res.body.failed).toEqual([]);
    expect(res.body.written).toHaveLength(1);

    const file = fs.readFileSync(path.join(folder, pairing.file));
    const { header: h, body: b } = decodeSnapshot(file, decodeKey(pairing.key));
    expect(h.deviceId).toBe(pairing.deviceId);
    expect(b.failed).toEqual([]);
    expect(Array.isArray(b.resources["/accounts"])).toBe(true);
    expect((b.resources["/accounts"] as unknown[]).length).toBeGreaterThan(0);
    const txKey = Object.keys(b.resources).find((k) => k.startsWith("/transactions?"))!;
    const tx = b.resources[txKey] as { items: unknown[]; total: number };
    expect(tx.items.length).toBe(tx.total);
    expect(tx.total).toBeGreaterThan(0);
    expect(Object.keys(b.resources).filter((k) => k.startsWith("/reports/month"))).toHaveLength(13);

    // The access token never leaves the PC.
    const item = db.select().from(plaidItems).get()!;
    const token = cipher.decrypt(item.accessTokenEncrypted, item.plaidItemId);
    expect(JSON.stringify(b)).not.toContain(token);

    const listed = await call("get", "/api/viewer/devices").expect(200);
    expect(listed.body.devices[0].lastWrittenAt).toBe(b.createdAt);
    expect(listed.body.devices[0].lastError).toBeNull();
  });

  it("records a folder that cannot be written, and keeps going", async () => {
    const { call } = makeViewerApp();
    const folder = tempDir();
    await call("post", "/api/viewer/devices").send({ name: "Pixel", folder }).expect(201);
    fs.rmSync(folder, { recursive: true });
    fs.writeFileSync(folder, "a file where the folder was");
    cleanups.push(() => fs.rmSync(folder, { force: true }));
    const res = await call("post", "/api/viewer/write").expect(200);
    expect(res.body.written).toEqual([]);
    expect(res.body.failed).toHaveLength(1);
    const listed = await call("get", "/api/viewer/devices").expect(200);
    expect(listed.body.devices[0].lastError).toMatch(/Could not write/);
  });

  it("does nothing when no phone is paired", async () => {
    const { call } = makeViewerApp();
    const res = await call("post", "/api/viewer/write").expect(200);
    expect(res.body).toEqual({ written: [], failed: [] });
  });
});

describe("renaming and forgetting a phone", () => {
  it("moves the file on rename, and deletes it and the key when forgotten", async () => {
    const { call, db } = makeViewerApp();
    const folder = tempDir();
    const paired = await call("post", "/api/viewer/devices")
      .send({ name: "Pixel", folder })
      .expect(201);
    const id = paired.body.device.id as number;
    await call("post", "/api/viewer/write").expect(200);
    const first = path.join(folder, (paired.body.pairing as PairingPayload).file);
    expect(fs.existsSync(first)).toBe(true);

    const renamed = await call("patch", `/api/viewer/devices/${id}`)
      .send({ name: "Work phone" })
      .expect(200);
    expect(fs.existsSync(first)).toBe(false);
    await call("post", "/api/viewer/write").expect(200);
    expect(fs.existsSync(renamed.body.file as string)).toBe(true);

    await call("delete", `/api/viewer/devices/${id}`).expect(204);
    expect(fs.existsSync(renamed.body.file as string)).toBe(false);
    expect(db.select().from(viewerDevices).get()!.keyEncrypted).toBe("");
    const listed = await call("get", "/api/viewer/devices").expect(200);
    expect(listed.body.devices).toEqual([]);
    await call("patch", `/api/viewer/devices/${id}`).send({ name: "Again" }).expect(404);
  });
});
