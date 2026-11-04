import type { Account } from "../types/api";
import { formatMinor } from "./money";
import { formatDay } from "./time";

export interface ReconcileLine {
  id: number;
  date: string;
  merchant: string;
  /** Positive is money out of a bank account, or more owed on a card. */
  amountMinor: number;
  pending: boolean;
}

export interface ReconcileGap {
  from: string;
  to: string;
  reason: "before_history" | "not_synced" | "no_longer_shared" | "quiet";
}

/** What GET /accounts/:id/reconcile returns. */
export interface Reconciliation {
  accountId: number;
  accountName: string;
  type: "depository" | "credit";
  statementDate: string;
  periodFrom: string;
  currentMinor: number;
  sinceCount: number;
  sinceMinor: number;
  ledgerMinor: number;
  statementMinor: number | null;
  differenceMinor: number | null;
  nearCutoff: ReconcileLine[];
  pending: ReconcileLine[];
  duplicates: Array<[ReconcileLine, ReconcileLine]>;
  gaps: ReconcileGap[];
}

/** A saved statement check. */
export interface ReconciliationRecord {
  id: number;
  accountId: number;
  statementDate: string;
  statementBalanceMinor: number;
  appBalanceMinor: number;
  /** Statement minus the app's figure when the check was saved. */
  differenceMinor: number;
  status: "matched" | "unresolved";
  note: string | null;
  createdAt: string;
}

/** What saving a check returns: the record, and the gaps behind its status. */
export type SavedReconciliation = ReconciliationRecord & { gaps: ReconcileGap[] };

/** "Oct 5": a day without its year, for lines that are about one period. */
export function shortDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The gaps that stop a check from being confirmed: the records stop short of the statement day. */
export function stopsShort(gaps: ReconcileGap[]): ReconcileGap | undefined {
  return gaps.find((g) => g.reason === "not_synced" || g.reason === "no_longer_shared");
}

/** Why a saved check is not marked as matched even though the figures agree. Null when it is not that. */
export function unconfirmedNote(gaps: ReconcileGap[]): string | null {
  const g = stopsShort(gaps);
  if (!g) return null;
  return `Your records stop on ${shortDay(prevDay(g.from))}, so this can't be confirmed yet — sync and check again.`;
}

/** Plain-English things that might explain a difference, one per line. */
export function causeLines(r: Reconciliation, currency: string): string[] {
  const lines: string[] = [];
  for (const [a, b] of r.duplicates) {
    const days =
      a.date === b.date ? shortDay(a.date) : `${shortDay(a.date)} and ${shortDay(b.date)}`;
    lines.push(
      `Possibly the same charge twice: ${a.merchant} on ${days} (${formatMinor(Math.abs(a.amountMinor), currency)})`,
    );
  }
  for (const g of r.gaps) {
    if (g.reason === "quiet") {
      lines.push(
        `No transactions from ${shortDay(g.from)} to ${shortDay(g.to)}, which is unusual for this account`,
      );
    } else if (g.reason === "before_history") {
      lines.push(
        `The app's records start on ${shortDay(addOne(g.to))}: anything before is missing`,
      );
    } else if (g.reason === "not_synced") {
      lines.push(`Not synced since ${shortDay(prevDay(g.from))}`);
    } else {
      lines.push(`The bank stopped sharing this account on ${shortDay(g.from)}`);
    }
  }
  return lines;
}

function shift(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
const addOne = (day: string) => shift(day, 1);
const prevDay = (day: string) => shift(day, -1);

/** The card's "Checked against a statement" line; only for a check that matched. */
export function checkedNote(a: Account): string | null {
  const last = a.lastReconciled;
  if (!last || last.status !== "matched") return null;
  return `Checked against a statement on ${formatDay(last.statementDate)}`;
}
