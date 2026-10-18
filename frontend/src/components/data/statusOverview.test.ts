import { describe, expect, it } from "vitest";
import type { Diagnostics } from "../../types/data";
import { ruleEffectText } from "../../pages/CategoriesPage";
import { statusItems } from "./StatusOverview";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const healthy: Diagnostics = {
  version: "0.1.0",
  dataDir: "C:/data",
  databaseFile: "C:/data/pf.db",
  databaseBytes: 1,
  migrationsApplied: 40,
  environment: "production",
  counts: { transactions: 1234 },
  integrity: { result: ["ok"], brokenReferences: 0, checkedAt: hoursAgo(0) },
  backups: {
    count: 4,
    newest: { name: "b.db", kind: "auto", sizeBytes: 1, createdAt: hoursAgo(20) },
    pendingRestore: null,
  },
  connections: [
    {
      id: 1,
      institutionName: "Bank",
      status: "active",
      lastSuccessfulSyncAt: hoursAgo(2),
      lastErrorCode: null,
    },
  ],
  recentProblems: [],
};

describe("the Settings status overview", () => {
  it("is all good when banks synced lately, a backup is recent and the data checks out", () => {
    const items = statusItems(healthy, NOW);
    expect(items.map((i) => [i.label, i.tone])).toEqual([
      ["Bank sync", "good"],
      ["Backups", "good"],
      ["Data", "good"],
    ]);
    expect(items[2]!.detail).toMatch(/1,234 transactions/);
    expect(items.every((i) => i.action === null)).toBe(true);
  });

  it("points to what needs doing", () => {
    const items = statusItems(
      {
        ...healthy,
        connections: [
          { ...healthy.connections[0]!, status: "login_required", institutionName: "Chase" },
        ],
        backups: { ...healthy.backups, newest: null, count: 0 },
        integrity: { ...healthy.integrity, brokenReferences: 2 },
      },
      NOW,
    );
    expect(items[0]).toMatchObject({ tone: "bad", action: { to: "/accounts" } });
    expect(items[0]!.detail).toMatch(/Chase/);
    expect(items[1]).toMatchObject({
      tone: "bad",
      value: "None yet",
      action: { to: "/settings/data" },
    });
    expect(items[2]).toMatchObject({ tone: "bad", value: "Needs a look" });
  });

  it("warns when the banks have not synced for days", () => {
    const stale = {
      ...healthy,
      connections: [{ ...healthy.connections[0]!, lastSuccessfulSyncAt: hoursAgo(24 * 5) }],
    };
    expect(statusItems(stale, NOW)[0]).toMatchObject({ tone: "warn" });
  });
});

describe("what saving a rule would do", () => {
  it("says how many it changes, not only how many it matches", () => {
    expect(ruleEffectText({ matchCount: 30, sample: [], changeCount: 12, manualCount: 2 })).toBe(
      "Saving changes 12 transactions (it matches 30); 2 chosen by hand stay.",
    );
    expect(ruleEffectText({ matchCount: 4, sample: [], changeCount: 0, manualCount: 0 })).toBe(
      "Saving changes nothing: the 4 it matches already have their category.",
    );
  });
});
