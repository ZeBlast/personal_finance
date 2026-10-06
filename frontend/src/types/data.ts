/** Shapes returned by the history, backup, export, and diagnostics endpoints. */

export interface NetWorthPoint {
  date: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  accountsObserved: number;
  gapDays: number | null;
}

export interface NetWorthHistory {
  currency: string;
  accountsTotal: number;
  points: NetWorthPoint[];
  gaps: Array<{ from: string; to: string; days: number }>;
  completeFrom: string | null;
}

export interface BackupInfo {
  name: string;
  kind: "manual" | "auto" | "pre-restore";
  sizeBytes: number;
  createdAt: string;
}

export interface PendingRestore {
  name: string;
  stagedAt: string;
}

export interface BackupList {
  directory: string;
  backups: BackupInfo[];
  pendingRestore: PendingRestore | null;
}

export type ExportKind =
  "transactions" | "accounts" | "investment-holdings" | "investment-transactions" | "everything";

export interface ExportResult {
  kind: ExportKind;
  name: string;
  path: string;
  directory: string;
  sizeBytes: number;
  rows: number;
}

export interface SyncProblem {
  id: number;
  institutionName: string;
  trigger: string;
  status: string;
  startedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface IntegrityReport {
  result: string[];
  brokenReferences: number;
  checkedAt: string;
}

export interface Diagnostics {
  version: string;
  dataDir: string;
  databaseFile: string;
  databaseBytes: number;
  migrationsApplied: number;
  environment: string;
  counts: Record<string, number>;
  integrity: IntegrityReport;
  backups: { count: number; newest: BackupInfo | null; pendingRestore: PendingRestore | null };
  connections: Array<{
    id: number;
    institutionName: string;
    status: string;
    lastSuccessfulSyncAt: string | null;
    lastErrorCode: string | null;
  }>;
  recentProblems: SyncProblem[];
}
