import type { GatewayTransaction, TransactionSyncPage } from "./gateway.js";

/**
 * Deterministic made-up transactions for the built-in demo gateway.
 *
 * The same inputs always give the same output, and the cursor records the "as of" day of the last
 * sync, so the ledger behaves like a real provider over time:
 *   - the first sync returns about 90 days of history, in pages;
 *   - later syncs return only what happened since, however long the gap was;
 *   - a transaction of the last two days is delivered as PENDING, and once it posts the pending
 *     one is reported as removed and a posted one (new ID, pointing at the old) is added;
 *   - some merchants are enriched a week after the transaction, reported as modified.
 */

export const HISTORY_DAYS = 90;
export const DEFAULT_PAGE_SIZE = 40;

/** A transaction is pending for this many days after its date. */
const PENDING_DAYS = 2;
/** Days after which the provider enriches a transaction's merchant name. */
const ENRICH_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function dateFromDayNumber(n: number): string {
  return isoDate(new Date(n * DAY_MS));
}

/** Small stable string hash (FNV-1a), so "random" amounts are repeatable. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface Draft {
  key: string;
  name: string;
  merchant: string | null;
  amount: number;
  category: [string, string];
  channel: string;
  payee?: string;
  payer?: string;
}

const cents = (min: number, span: number, h: number): number => (min + (h % span)) / 100;

/** What an account does on one day. `accountIndex` follows the order in FAKE_INSTITUTIONS. */
function draftsFor(institutionId: string, accountIndex: number, date: string): Draft[] {
  const h = hash(`${institutionId}|${accountIndex}|${date}`);
  const h2 = hash(`${date}|${accountIndex}|amount`);
  const dayOfMonth = Number(date.slice(8, 10));
  const daysSinceEpoch = dayNumber(date);
  const drafts: Draft[] = [];

  if (institutionId === "ins_fake_bank" && accountIndex === 0) {
    if (h % 3 === 0) {
      drafts.push({
        key: "groc",
        name: "WHOLEFDS MKT 10234",
        merchant: "Whole Foods Market",
        amount: cents(2000, 10000, h2),
        category: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"],
        channel: "in store",
      });
    }
    if (h % 5 === 1) {
      drafts.push({
        key: "rest",
        name: "CHIPOTLE 2041",
        merchant: "Chipotle",
        amount: cents(800, 5200, h2),
        category: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"],
        channel: "in store",
      });
    }
    if (daysSinceEpoch % 14 === 0) {
      drafts.push({
        key: "pay",
        name: "ACME CORP DIRECT DEP",
        merchant: "ACME Corp",
        amount: -2500,
        category: ["INCOME", "INCOME_WAGES"],
        channel: "other",
      });
    }
    if (dayOfMonth === 1) {
      drafts.push({
        key: "rent",
        name: "OAK STREET APARTMENTS RENT",
        merchant: "Oak Street Apartments",
        amount: 1450,
        category: ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT"],
        channel: "online",
      });
    }
    if (h % 11 === 3) {
      drafts.push({
        key: "zout",
        name: "Zelle payment to Jane Doe 4821",
        merchant: null,
        amount: cents(1500, 6500, h2),
        category: ["TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"],
        channel: "other",
      });
    }
    if (h % 13 === 4) {
      drafts.push({
        key: "zin",
        name: "Zelle payment from Alex Smith 90211",
        merchant: null,
        amount: -cents(2000, 8000, h2),
        category: ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"],
        channel: "other",
      });
    }
    if (h % 17 === 5) {
      drafts.push({
        key: "bill",
        name: "BILL PAY ONLINE",
        merchant: null,
        amount: cents(4000, 5000, h2),
        category: ["TRANSFER_OUT", "TRANSFER_OUT_OTHER_TRANSFER_OUT"],
        channel: "online",
        payee: "Sam Lee",
      });
    }
  } else if (institutionId === "ins_fake_bank" && accountIndex === 1) {
    if (dayOfMonth === 28) {
      drafts.push({
        key: "int",
        name: "INTEREST PAYMENT",
        merchant: null,
        amount: -0.45,
        category: ["INCOME", "INCOME_INTEREST_EARNED"],
        channel: "other",
      });
    }
  } else if (institutionId === "ins_fake_bank" && accountIndex === 2) {
    if (h % 2 === 0) {
      drafts.push({
        key: "amzn",
        name: "AMAZON MKTPLACE PMTS",
        merchant: "Amazon",
        amount: cents(2500, 17500, h2),
        category: ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"],
        channel: "online",
      });
    }
    if (h % 7 === 2) {
      drafts.push({
        key: "gas",
        name: "SHELL OIL 57444",
        merchant: "Shell",
        amount: cents(2500, 3500, h2),
        category: ["TRANSPORTATION", "TRANSPORTATION_GAS"],
        channel: "in store",
      });
    }
    if (h % 9 === 3) {
      drafts.push({
        key: "nflx",
        name: "NETFLIX.COM",
        merchant: "Netflix",
        amount: 15.49,
        category: ["ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES"],
        channel: "online",
      });
    }
    if (dayOfMonth === 20) {
      drafts.push({
        key: "ccpay",
        name: "PAYMENT THANK YOU",
        merchant: null,
        amount: -300,
        category: ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"],
        channel: "other",
      });
    }
  } else if (institutionId === "ins_fake_oauth" && accountIndex === 0) {
    if (h % 3 === 0) {
      drafts.push({
        key: "groc",
        name: "TRADER JOE S 552",
        merchant: "Trader Joe's",
        amount: cents(1800, 9000, h2),
        category: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"],
        channel: "in store",
      });
    }
  }
  return drafts;
}

/** Whether the provider has enriched this transaction's merchant by `asOf`. */
function enriched(draftHash: number, date: string, asOf: string): boolean {
  if (draftHash % 4 !== 0) return true; // these always have a merchant from the start
  return dayNumber(asOf) >= dayNumber(date) + ENRICH_AFTER_DAYS;
}

function build(
  accountId: string,
  draft: Draft,
  date: string,
  asOf: string,
  state: "pending" | "posted",
  replacesPending: boolean,
): GatewayTransaction {
  const base = `${accountId}~${date}~${draft.key}`;
  const merchant = enriched(hash(base), date, asOf) ? draft.merchant : null;
  return {
    transactionId: `${state === "pending" ? "ptxn-fake~" : "txn-fake~"}${base}`,
    accountId,
    pendingTransactionId: state === "posted" && replacesPending ? `ptxn-fake~${base}` : null,
    date,
    authorizedDate: date,
    name: draft.name,
    merchantName: merchant,
    amount: draft.amount,
    currency: "USD",
    pending: state === "pending",
    paymentChannel: draft.channel,
    categoryPrimary: draft.category[0],
    categoryDetailed: draft.category[1],
    counterparties: merchant ? [{ name: merchant, type: "merchant" }] : [],
    paymentPayee: draft.payee ?? null,
    paymentPayer: draft.payer ?? null,
  };
}

export interface LedgerAccount {
  /** The provider's account ID. */
  accountId: string;
  index: number;
}

interface Delta {
  added: GatewayTransaction[];
  modified: GatewayTransaction[];
  removedIds: string[];
}

/** Everything that changed between the end of the previous sync (`last`) and `asOf`. */
export function ledgerDelta(
  institutionId: string,
  accounts: LedgerAccount[],
  last: string | null,
  asOf: string,
): Delta {
  const delta: Delta = { added: [], modified: [], removedIds: [] };
  const end = dayNumber(asOf);
  const firstNew = last === null ? end - (HISTORY_DAYS - 1) : dayNumber(last) + 1;
  const lastN = last === null ? null : dayNumber(last);

  for (const { accountId, index } of accounts) {
    // 1. Brand-new days.
    for (let d = firstNew; d <= end; d++) {
      const date = dateFromDayNumber(d);
      for (const draft of draftsFor(institutionId, index, date)) {
        const state = end - d < PENDING_DAYS ? "pending" : "posted";
        delta.added.push(build(accountId, draft, date, asOf, state, false));
      }
    }
    if (lastN === null) continue;

    // 2. Older transactions whose state changed since the last sync (pending ones that posted,
    //    merchants enriched). Nothing older than a week before the last sync can change.
    for (let d = lastN - ENRICH_AFTER_DAYS; d <= lastN; d++) {
      const date = dateFromDayNumber(d);
      for (const draft of draftsFor(institutionId, index, date)) {
        const wasPending = lastN - d < PENDING_DAYS;
        const isPending = end - d < PENDING_DAYS;
        const dh = hash(`${accountId}~${date}~${draft.key}`);
        if (wasPending && !isPending) {
          const pendingVersion = build(accountId, draft, date, asOf, "pending", false);
          delta.removedIds.push(pendingVersion.transactionId);
          delta.added.push(build(accountId, draft, date, asOf, "posted", true));
        } else if (!wasPending && !isPending && dh % 4 === 0) {
          const before = enriched(dh, date, dateFromDayNumber(lastN));
          const after = enriched(dh, date, asOf);
          if (!before && after) {
            delta.modified.push(build(accountId, draft, date, asOf, "posted", false));
          }
        }
      }
    }
  }
  return delta;
}

/**
 * Cursor formats: `fake~<asOf>` after a completed sync; `fake~<asOf>~<offset>~<last|none>` in the
 * middle of a multi-page sync (where `last` is the as-of day the sync started from).
 */
export function pageLedger(
  institutionId: string,
  accounts: LedgerAccount[],
  cursor: string | null,
  today: string,
  pageSize: number,
): TransactionSyncPage {
  let asOf = today;
  let last: string | null = null;
  let offset = 0;

  if (cursor !== null) {
    const parts = cursor.split("~");
    if (parts[0] !== "fake" || !parts[1]) throw new Error("invalid cursor");
    if (parts.length === 2) {
      last = parts[1];
      // A clock that moved backwards must not make the ledger forget what it already delivered.
      asOf = parts[1] > today ? parts[1] : today;
    } else {
      asOf = parts[1];
      offset = Number(parts[2]);
      last = parts[3] === "none" ? null : (parts[3] ?? null);
    }
  }

  const delta = ledgerDelta(institutionId, accounts, last, asOf);
  const slice = delta.added.slice(offset, offset + pageSize);
  const reachedEnd = offset + pageSize >= delta.added.length;
  return {
    added: slice,
    modified: reachedEnd ? delta.modified : [],
    removedIds: reachedEnd ? delta.removedIds : [],
    nextCursor: reachedEnd ? `fake~${asOf}` : `fake~${asOf}~${offset + pageSize}~${last ?? "none"}`,
    hasMore: !reachedEnd,
  };
}
