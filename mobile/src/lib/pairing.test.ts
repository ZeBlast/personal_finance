import { describe, expect, it } from "vitest";
import { DEVICE, pairingCode } from "../test/fixtures";
import { parsePairing } from "./pairing";

describe("reading the pairing code", () => {
  it("accepts the PC's code", () => {
    expect(parsePairing(pairingCode())).toMatchObject({ deviceId: DEVICE, name: "Pixel" });
  });

  it("refuses anything else", () => {
    expect(parsePairing("https://example.com")).toBeNull();
    expect(parsePairing(JSON.stringify({ pfViewer: 2 }))).toBeNull();
    expect(
      parsePairing(
        JSON.stringify({ pfViewer: 1, deviceId: "d", name: "n", key: "short", file: "f" }),
      ),
    ).toBeNull();
  });
});
