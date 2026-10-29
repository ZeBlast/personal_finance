import { describe, expect, it } from "vitest";
import type { Settings } from "../../types/api";
import { statusItems } from "../data/StatusOverview";
import { welcomeComplete, welcomeSteps } from "./Welcome";

const settings = { recoveryKeySaved: false, plaidEnvironment: "fake" } as Settings;

describe("the first-run welcome", () => {
  it("asks for an account and the recovery key; categories are optional", () => {
    const steps = welcomeSteps(settings, 0);
    expect(steps.map((s) => [s.key, s.done, s.optional])).toEqual([
      ["account", false, false],
      ["recovery", false, false],
      ["categories", false, true],
    ]);
    expect(welcomeComplete(steps)).toBe(false);
  });

  it("adds an optional Plaid step once the key status is known", () => {
    expect(welcomeSteps(settings, 0, false)[0]).toMatchObject({
      key: "plaid",
      done: false,
      optional: true,
    });
    expect(welcomeSteps(settings, 0, true)[0]).toMatchObject({ key: "plaid", done: true });
    expect(welcomeComplete(welcomeSteps({ ...settings, recoveryKeySaved: true }, 1, false))).toBe(
      true,
    );
  });

  it("is complete once there is an account and the key is saved", () => {
    const steps = welcomeSteps({ ...settings, recoveryKeySaved: true }, 2);
    expect(welcomeComplete(steps)).toBe(true);
  });
});

describe("the recovery key status", () => {
  const diagnostics = {
    counts: {},
    integrity: { result: ["ok"], brokenReferences: 0, checkedAt: "" },
    backups: { count: 0, newest: null, pendingRestore: null },
    connections: [],
    recentProblems: [],
  } as unknown as Parameters<typeof statusItems>[0];

  it("warns until the key is saved, and is left out when unknown", () => {
    expect(statusItems(diagnostics, Date.now(), false).at(-1)).toMatchObject({
      label: "Recovery key",
      tone: "warn",
      action: { to: "/settings/data?show=recovery-key" },
    });
    expect(statusItems(diagnostics, Date.now(), true).at(-1)).toMatchObject({ tone: "good" });
    expect(statusItems(diagnostics).map((i) => i.label)).not.toContain("Recovery key");
  });
});
