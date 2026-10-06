import { asc, eq } from "drizzle-orm";
import { accounts, balanceSnapshots, plaidItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import type { GatewayAccount } from "../plaid/gateway.js";
import { toMinorUnits } from "../utils/money.js";
import { currentCreditLimit, observeCreditLimit } from "./credit-limit.service.js";

/** Display colors handed out to accounts in order; also used by the calendar later. */
const PALETTE = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#ca8a04",
  "#db2777",
];

/** The display color for the account with this ID. */
export function accountColor(accountId: number): string {
  return PALETTE[(accountId - 1) % PALETTE.length]!;
}

export interface AccountSummary {
  id: number;
  itemId: number | null;
  institutionName: string | null;
  connectionStatus: string | null;
  connectionEnvironment: string | null;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string;
  currentBalanceMinor: number | null;
  availableBalanceMinor: number | null;
  lastBalanceUpdateAt: string | null;
  source: string;
  isManual: boolean;
  color: string | null;
  /** Current credit limit for credit accounts, from the limit history; null otherwise. */
  creditLimitMinor: number | null;
}

const summaryColumns = {
  id: accounts.id,
  itemId: accounts.plaidItemId,
  institutionName: plaidItems.institutionName,
  connectionStatus: plaidItems.status,
  connectionEnvironment: plaidItems.environment,
  name: accounts.name,
  officialName: accounts.officialName,
  type: accounts.type,
  subtype: accounts.subtype,
  mask: accounts.mask,
  currency: accounts.currency,
  currentBalanceMinor: accounts.currentBalanceMinor,
  availableBalanceMinor: accounts.availableBalanceMinor,
  lastBalanceUpdateAt: accounts.lastBalanceUpdateAt,
  source: accounts.source,
  isManual: accounts.isManual,
  color: accounts.color,
};

export function listAccounts(db: AppDb, itemId?: number): AccountSummary[] {
  const query = db
    .select(summaryColumns)
    .from(accounts)
    .leftJoin(plaidItems, eq(accounts.plaidItemId, plaidItems.id));
  const rows = itemId === undefined ? query : query.where(eq(accounts.plaidItemId, itemId));
  const today = new Date().toISOString().slice(0, 10);
  return rows
    .orderBy(asc(accounts.id))
    .all()
    .map((row) => ({
      ...row,
      creditLimitMinor:
        row.type === "credit" ? (currentCreditLimit(db, row.id, today)?.limitMinor ?? null) : null,
    }));
}

/** Provider account ID to internal account ID, for the accounts of one connection. */
export function accountIdsByPlaidId(
  db: Pick<AppDb, "select">,
  itemRowId: number,
): Map<string, number> {
  const rows = db
    .select({ id: accounts.id, plaidAccountId: accounts.plaidAccountId })
    .from(accounts)
    .where(eq(accounts.plaidItemId, itemRowId))
    .all();
  const map = new Map<string, number>();
  for (const row of rows) if (row.plaidAccountId) map.set(row.plaidAccountId, row.id);
  return map;
}

/**
 * Records the balances seen during a successful sync, and any credit-limit change. Returns how
 * many credit-limit changes were noticed.
 */
export function recordObservations(
  db: Pick<AppDb, "select" | "insert">,
  itemRowId: number,
  gatewayAccounts: GatewayAccount[],
  observedAt: string,
): number {
  const ids = accountIdsByPlaidId(db, itemRowId);
  const today = observedAt.slice(0, 10);
  let limitChanges = 0;
  for (const incoming of gatewayAccounts) {
    const accountId = ids.get(incoming.accountId);
    if (accountId === undefined) continue;
    db.insert(balanceSnapshots)
      .values({
        accountId,
        observedAt,
        currentBalanceMinor: toMinorUnits(incoming.currentBalance, incoming.currency),
        availableBalanceMinor: toMinorUnits(incoming.availableBalance, incoming.currency),
        currency: incoming.currency,
      })
      .run();
    const limitMinor = toMinorUnits(incoming.creditLimit, incoming.currency);
    if (incoming.type === "credit" && limitMinor !== null) {
      if (observeCreditLimit(db, accountId, limitMinor, incoming.currency, today, observedAt)) {
        limitChanges += 1;
      }
    }
  }
  return limitChanges;
}

/**
 * Inserts or updates the accounts Plaid reports for an Item. Matching is by Plaid's account ID,
 * so running it repeatedly never duplicates an account, and user-chosen fields (color) survive.
 */
export function upsertItemAccounts(
  db: Pick<AppDb, "select" | "insert" | "update">,
  itemRowId: number,
  gatewayAccounts: GatewayAccount[],
  now: string,
): void {
  for (const incoming of gatewayAccounts) {
    const values = {
      name: incoming.name,
      officialName: incoming.officialName,
      type: incoming.type,
      subtype: incoming.subtype,
      mask: incoming.mask,
      currency: incoming.currency,
      currentBalanceMinor: toMinorUnits(incoming.currentBalance, incoming.currency),
      availableBalanceMinor: toMinorUnits(incoming.availableBalance, incoming.currency),
      lastBalanceUpdateAt: now,
      updatedAt: now,
    };
    const existing = db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.plaidAccountId, incoming.accountId))
      .get();
    if (existing) {
      db.update(accounts).set(values).where(eq(accounts.id, existing.id)).run();
      continue;
    }
    const inserted = db
      .insert(accounts)
      .values({
        ...values,
        plaidItemId: itemRowId,
        plaidAccountId: incoming.accountId,
        isManual: false,
        source: "plaid",
        createdAt: now,
      })
      .returning({ id: accounts.id })
      .get();
    db.update(accounts)
      .set({ color: accountColor(inserted.id) })
      .where(eq(accounts.id, inserted.id))
      .run();
  }
}
