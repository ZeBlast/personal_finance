import type { Diagnostics } from "../types/data";

/** What to do about a failed sync, by the code the app recorded. Plain words, one next step. */
export interface Advice {
  /** What happened, in a few words. */
  summary: string;
  /** What to do about it. */
  action: string;
  /** Where in the app the fix is, if there is one. */
  fixPath?: string;
  /** True when waiting or retrying is all that is needed. */
  transient: boolean;
}

const ADVICE: Record<string, Advice> = {
  NETWORK_ERROR: {
    summary: "The computer was offline or Plaid could not be reached.",
    action: "Nothing is wrong with your data. Press Sync now when you are online.",
    transient: true,
  },
  ITEM_LOGIN_REQUIRED: {
    summary: "The bank wants you to sign in again.",
    action: "Open Accounts and choose Reconnect for this bank.",
    fixPath: "/accounts",
    transient: false,
  },
  PENDING_EXPIRATION: {
    summary: "The bank connection is about to expire.",
    action: "Open Accounts and choose Reconnect for this bank soon.",
    fixPath: "/accounts",
    transient: false,
  },
  USER_PERMISSION_REVOKED: {
    summary: "Access was withdrawn at the bank.",
    action: "Open Accounts and reconnect this bank if you still want it tracked.",
    fixPath: "/accounts",
    transient: false,
  },
  PRODUCT_NOT_READY: {
    summary: "The bank has not finished preparing the data yet.",
    action: "Try Sync now again in a few minutes.",
    transient: true,
  },
  storage_error: {
    summary: "The data could not be saved on this computer.",
    action:
      "Check that the disk has free space, then sync again. Nothing was lost; the next sync continues from the last saved point.",
    fixPath: "/data",
    transient: false,
  },
  token_unreadable: {
    summary: "The saved connection key cannot be read, so this connection cannot be used.",
    action: "Disconnect this bank on Accounts and connect it again.",
    fixPath: "/accounts",
    transient: false,
  },
  wrong_environment: {
    summary: "This connection belongs to a different data source (demo, Sandbox or Production).",
    action: "Switch the data source back in Settings, or reconnect under the current one.",
    fixPath: "/settings",
    transient: false,
  },
  interrupted: {
    summary: "The app was closed in the middle of a sync.",
    action: "Nothing to do: the next sync picks up where it stopped.",
    transient: true,
  },
  RATE_LIMIT_EXCEEDED: {
    summary: "Plaid asked the app to slow down.",
    action: "Wait a few minutes, then press Sync now.",
    transient: true,
  },
  INTERNAL_SERVER_ERROR: {
    summary: "Plaid had a problem on its side.",
    action: "Try again later.",
    transient: true,
  },
};

const FALLBACK: Advice = {
  summary: "The sync failed for a reason the app does not recognize.",
  action:
    "Try Sync now again. If it keeps failing, copy the report on the Data page when asking for help.",
  fixPath: "/data",
  transient: true,
};

export function adviceFor(code: string | null): Advice {
  return (code && ADVICE[code]) || FALLBACK;
}

/** "1.4 MB", "820 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The diagnostics as plain text for pasting into a message. It holds only counts, sizes, dates and
 * error codes (the data folder path is included, since it is usually the first thing asked for).
 */
export function formatReport(d: Diagnostics): string {
  const lines = [
    `Personal Finance ${d.version}`,
    `Data source: ${d.environment}`,
    `Data folder: ${d.dataDir}`,
    `Database: ${formatBytes(d.databaseBytes)}, ${d.migrationsApplied} migrations applied`,
    `Integrity: ${d.integrity.result.join("; ")}; broken references: ${d.integrity.brokenReferences}`,
    `Backups: ${d.backups.count}${d.backups.newest ? `, newest ${d.backups.newest.createdAt}` : ""}${
      d.backups.pendingRestore ? `, restore queued (${d.backups.pendingRestore.name})` : ""
    }`,
    "Rows: " +
      Object.entries(d.counts)
        .map(([table, n]) => `${table} ${n}`)
        .join(", "),
    "Connections:",
    ...d.connections.map(
      (c) =>
        `  ${c.institutionName}: ${c.status}, last good sync ${c.lastSuccessfulSyncAt ?? "never"}${
          c.lastErrorCode ? `, last error ${c.lastErrorCode}` : ""
        }`,
    ),
    "Recent sync problems:",
    ...(d.recentProblems.length === 0
      ? ["  none"]
      : d.recentProblems.map((p) =>
          `  ${p.startedAt} ${p.institutionName} ${p.trigger} ${p.status} ${p.errorCode ?? ""}`.trimEnd(),
        )),
  ];
  return lines.join("\n");
}
