import { describe, expect, it } from "vitest";
import type { Diagnostics } from "../types/data";
import { adviceFor, formatBytes, formatReport } from "./recovery";

describe("adviceFor", () => {
  it("tells apart problems that need the user from ones that just need time", () => {
    expect(adviceFor("NETWORK_ERROR")).toMatchObject({ transient: true });
    expect(adviceFor("NETWORK_ERROR").fixPath).toBeUndefined();
    expect(adviceFor("ITEM_LOGIN_REQUIRED")).toMatchObject({
      transient: false,
      fixPath: "/accounts",
    });
    expect(adviceFor("storage_error").fixPath).toBe("/settings/data");
    expect(adviceFor("wrong_environment").fixPath).toBe("/settings");
  });

  it("always says what happened and what to do, and only points at real pages", () => {
    const codes = [
      "NETWORK_ERROR",
      "ITEM_LOGIN_REQUIRED",
      "PENDING_EXPIRATION",
      "USER_PERMISSION_REVOKED",
      "PRODUCT_NOT_READY",
      "storage_error",
      "token_unreadable",
      "wrong_environment",
      "interrupted",
      "RATE_LIMIT_EXCEEDED",
      "INTERNAL_SERVER_ERROR",
      "SOMETHING_NEW",
      null,
    ];
    for (const code of codes) {
      const a = adviceFor(code);
      expect(a.summary.length, String(code)).toBeGreaterThan(10);
      expect(a.action.length, String(code)).toBeGreaterThan(10);
      if (a.fixPath) expect(["/accounts", "/settings", "/settings/data"]).toContain(a.fixPath);
    }
  });

  it("falls back to general advice for an unknown code", () => {
    expect(adviceFor("SOMETHING_NEW")).toBe(adviceFor(null));
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(5000 * 1024 ** 3)).toBe("5000 GB");
  });
});

describe("formatReport", () => {
  const base: Diagnostics = {
    version: "0.1.0",
    dataDir: "C:\\Users\\me\\AppData\\Roaming\\PersonalFinance",
    databaseFile: "C:\\x\\personal-finance.db",
    databaseBytes: 2_097_152,
    migrationsApplied: 6,
    environment: "fake",
    counts: { accounts: 3, transactions: 120 },
    integrity: { result: ["ok"], brokenReferences: 0, checkedAt: "2026-10-05T10:00:00Z" },
    backups: { count: 2, newest: null, pendingRestore: null },
    connections: [
      {
        id: 1,
        institutionName: "First Platypus Bank",
        status: "login_required",
        lastSuccessfulSyncAt: null,
        lastErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ],
    recentProblems: [],
  };

  it("summarizes health in plain text", () => {
    const text = formatReport(base);
    expect(text).toContain("Personal Finance 0.1.0");
    expect(text).toContain("Database: 2.0 MB, 6 migrations applied");
    expect(text).toContain("Integrity: ok; broken references: 0");
    expect(text).toContain("Rows: accounts 3, transactions 120");
    expect(text).toContain(
      "First Platypus Bank: login_required, last good sync never, last error ITEM_LOGIN_REQUIRED",
    );
    expect(text).toContain("Recent sync problems:\n  none");
  });

  it("includes problems and a queued restore when there are some", () => {
    const text = formatReport({
      ...base,
      backups: {
        count: 3,
        newest: {
          name: "pf-auto-1.db",
          kind: "auto",
          sizeBytes: 1,
          createdAt: "2026-10-04T08:00:00Z",
        },
        pendingRestore: { name: "pf-manual-2.db", stagedAt: "2026-10-05T09:00:00Z" },
      },
      recentProblems: [
        {
          id: 9,
          institutionName: "First Platypus Bank",
          trigger: "launch",
          status: "offline",
          startedAt: "2026-10-05T07:00:00Z",
          errorCode: "NETWORK_ERROR",
          errorMessage: "Could not reach Plaid.",
        },
      ],
    });
    expect(text).toContain(
      "Backups: 3, newest 2026-10-04T08:00:00Z, restore queued (pf-manual-2.db)",
    );
    expect(text).toContain("2026-10-05T07:00:00Z First Platypus Bank launch offline NETWORK_ERROR");
    expect(text).not.toContain("none");
  });
});
