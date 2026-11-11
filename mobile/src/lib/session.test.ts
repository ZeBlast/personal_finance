// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fakeNative, makeFile } from "../test/fixtures";
import { createSession, pickedFile } from "./session";

afterEach(() => localStorage.clear());

describe("the phone's session", () => {
  it("pairs, picks the file, and opens it; next time it starts locked", async () => {
    const { native, state } = fakeNative({ file: makeFile({ "/accounts": [] }) });
    const session = createSession(native);
    expect(await session.start()).toEqual({ kind: "unpaired" });
    expect(await session.pair()).toMatchObject({
      kind: "needFile",
      expectedName: "pf-viewer-pixel-dev123.snap",
    });
    const ready = await session.pick();
    expect(ready).toMatchObject({ kind: "ready", source: "file", problem: null });
    expect(pickedFile()?.uri).toBe("content://drive/1");
    expect(state.cache).not.toBeNull();

    const later = createSession(native);
    expect(await later.start()).toEqual({ kind: "locked", problem: null });
    expect(await later.load()).toMatchObject({ kind: "ready" });
    expect(state.unlocks).toBe(1);
  });

  it("shows the last good copy when the file cannot be read", async () => {
    const { native, state } = fakeNative({ file: makeFile({ "/accounts": [] }) });
    const session = createSession(native);
    await session.pair();
    await session.pick();
    state.file = null;
    const phase = await session.load();
    expect(phase).toMatchObject({ kind: "ready", source: "cache" });
    expect(phase.kind === "ready" && phase.problem).toMatch(/Could not read/);
  });

  it("asks for the file again when it belongs to another phone", async () => {
    const { native } = fakeNative({ file: makeFile({}, { deviceId: "another" }) });
    const session = createSession(native);
    await session.pair();
    expect(await session.pick()).toMatchObject({ kind: "needFile", problem: /another phone/ });
  });

  it("refuses a code that is not a pairing code", async () => {
    const { native } = fakeNative({ scanCode: async () => ({ text: "hello" }) });
    await expect(createSession(native).pair()).rejects.toThrow(/not a Finance pairing code/);
  });

  it("forgets everything", async () => {
    const { native, state } = fakeNative({ file: makeFile({}) });
    const session = createSession(native);
    await session.pair();
    await session.pick();
    expect(await session.forget()).toEqual({ kind: "unpaired" });
    expect(state.key).toBeNull();
    expect(pickedFile()).toBeNull();
    expect(await session.start()).toEqual({ kind: "unpaired" });
  });
});
