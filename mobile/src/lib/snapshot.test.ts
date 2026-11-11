import { describe, expect, it } from "vitest";
import { DEVICE, KEY, makeFile } from "../test/fixtures";
import {
  fromBase64,
  fromBase64Url,
  openSnapshot,
  readHeader,
  SnapshotError,
  toBase64,
} from "./snapshot";

describe("opening a snapshot the PC wrote", () => {
  it("reads the header and decrypts the body", async () => {
    const file = makeFile({ "/accounts": [{ id: 1, name: "Checking" }] });
    expect(readHeader(file).header.deviceId).toBe(DEVICE);
    const { body } = await openSnapshot(file, KEY, DEVICE);
    expect(body.resources["/accounts"]).toEqual([{ id: 1, name: "Checking" }]);
    expect(body.today).toBe("2026-11-09");
  });

  it("refuses the wrong key", async () => {
    const file = makeFile({});
    await expect(openSnapshot(file, new Uint8Array(32).fill(8))).rejects.toMatchObject({
      code: "wrong_key",
    });
  });

  it("refuses another phone's file", async () => {
    const file = makeFile({}, { deviceId: "someone-else" });
    await expect(openSnapshot(file, KEY, DEVICE)).rejects.toMatchObject({ code: "wrong_phone" });
  });

  it("refuses a changed file", async () => {
    const file = makeFile({ "/accounts": [] });
    file[file.length - 1]! ^= 1;
    await expect(openSnapshot(file, KEY)).rejects.toBeInstanceOf(SnapshotError);
  });

  it("refuses something else", () => {
    expect(() => readHeader(new TextEncoder().encode("hello, this is not it"))).toThrow(
      /not a Finance Viewer snapshot/,
    );
  });
});

describe("base64", () => {
  it("round-trips, and reads the pairing code's base64url", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64Url(Buffer.from(KEY).toString("base64url"))).toEqual(KEY);
  });
});
