import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { plaidItems, syncRuns, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import {
  PlaidGatewayError,
  REAUTH_ERROR_CODES,
  type GatewayTransaction,
  type TransactionSyncPage,
} from "../plaid/gateway.js";
import type { GatewayProvider } from "../plaid/provider.js";
import { toGatewayError } from "../plaid/real-gateway.js";
import { addDays } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { accountIdsByPlaidId, recordObservations, upsertItemAccounts } from "./account.service.js";
import type { TokenCipher } from "./crypto.js";
import {
  applyHoldingsSnapshot,
  applyInvestmentTransactions,
  hasInvestmentAccounts,
} from "./investment.service.js";
import { getSettings } from "./settings.service.js";
import { applyRules } from "./rule.service.js";
import { removeTransactions, upsertTransaction } from "./transaction.service.js";

export type SyncTrigger = "launch" | "manual" | "interval";

export interface SyncRunSummary {
  id: number;
  itemId: number;
  institutionName: string;
  trigger: SyncTrigger;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  modified: number;
  removed: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SyncSkip {
  itemId: number;
  institutionName: string;
  reason: "cooldown" | "interval" | "needs_signin";
}

export interface SyncAllResult {
  runs: SyncRunSummary[];
  skipped: SyncSkip[];
}

interface Deps {
  db: AppDb;
  cipher: TokenCipher;
  getGateway: GatewayProvider;
  /** The clock; replaceable so tests can move time. */
  now?: () => Date;
}

/** How many times a sync restarts after the provider reports that data changed mid-pagination. */
const MAX_RESTARTS = 3;
/** Never retry a failing connection more often than this on the automatic interval. */
const MIN_RETRY_MINUTES = 5;

type ItemRow = typeof plaidItems.$inferSelect;
const MINUTE = 60_000;

/** Investment transactions are re-read this far back on each sync, so late-posting ones are caught. */
const INVESTMENT_OVERLAP_DAYS = 45;
/** How far back the first investment pull goes (Plaid keeps up to 24 months). */
const INVESTMENT_FIRST_PULL_DAYS = 730;
/**
 * Plaid codes meaning "this connection was not set up for that product", as seen against real
 * Plaid: a brokerage linked for Investments only answers a Transactions request with
 * ADDITIONAL_CONSENT_REQUIRED, and a bank that has no investments answers an Investments request
 * with PRODUCTS_NOT_SUPPORTED. Where the other kind of data is simply not offered, that is skipped,
 * not an error.
 */
const PRODUCT_UNAVAILABLE = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "ADDITIONAL_CONSENT_REQUIRED",
  "INVALID_PRODUCT",
]);

/** Asks for investment data, returning null when the connection simply has none to give. */
async function optionalInvestmentData<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    const failure = toGatewayError(error);
    if (PRODUCT_UNAVAILABLE.has(failure.code)) return null;
    throw failure;
  }
}

/** A failure while saving to the local database, kept apart from failures talking to Plaid. */
class StorageError extends Error {}

/** Runs a local database step, labelling any failure as a storage problem. */
function store<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw new StorageError(error instanceof Error ? error.message : "unknown error");
  }
}

export function createSyncService({ db, cipher, getGateway, now = () => new Date() }: Deps) {
  /** Syncs in progress, by connection, so two requests never pull the same connection twice. */
  const inFlight = new Map<number, Promise<SyncRunSummary>>();
  /** When the automatic interval last tried each connection, for retry spacing (in memory only). */
  const lastIntervalAttempt = new Map<number, number>();
  const iso = (): string => now().toISOString();

  function requireItem(id: number): ItemRow {
    const row = db.select().from(plaidItems).where(eq(plaidItems.id, id)).get();
    if (!row) throw notFound("That connection");
    return row;
  }

  function summarize(runId: number): SyncRunSummary {
    const row = db
      .select({
        id: syncRuns.id,
        itemId: syncRuns.plaidItemId,
        institutionName: plaidItems.institutionName,
        trigger: syncRuns.trigger,
        status: syncRuns.status,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        added: syncRuns.addedCount,
        modified: syncRuns.modifiedCount,
        removed: syncRuns.removedCount,
        errorCode: syncRuns.errorCode,
        errorMessage: syncRuns.errorMessage,
      })
      .from(syncRuns)
      .innerJoin(plaidItems, eq(syncRuns.plaidItemId, plaidItems.id))
      .where(eq(syncRuns.id, runId))
      .get();
    if (!row) throw notFound("That sync run");
    return { ...row, trigger: row.trigger as SyncTrigger };
  }

  function markItemProblem(itemId: number, failure: PlaidGatewayError): void {
    db.update(plaidItems)
      .set({
        status: REAUTH_ERROR_CODES.has(failure.code) ? "login_required" : "error",
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
        updatedAt: iso(),
      })
      .where(eq(plaidItems.id, itemId))
      .run();
  }

  async function runSync(itemId: number, trigger: SyncTrigger): Promise<SyncRunSummary> {
    const item = requireItem(itemId);
    const run = db
      .insert(syncRuns)
      .values({ plaidItemId: itemId, trigger, status: "running", startedAt: iso() })
      .returning({ id: syncRuns.id })
      .get();

    // Distinct IDs, so work repeated after a restart (idempotent) is not counted twice.
    const addedIds = new Set<string>();
    const modifiedIds = new Set<string>();
    const removedIds = new Set<string>();

    const finish = (
      status: string,
      extra: { errorCode?: string; errorMessage?: string } = {},
    ): SyncRunSummary => {
      db.update(syncRuns)
        .set({
          status,
          finishedAt: iso(),
          addedCount: addedIds.size,
          modifiedCount: modifiedIds.size,
          removedCount: removedIds.size,
          errorCode: extra.errorCode ?? null,
          errorMessage: extra.errorMessage ?? null,
        })
        .where(eq(syncRuns.id, run.id))
        .run();
      return summarize(run.id);
    };

    try {
      const gateway = getGateway();
      if (gateway.environment !== item.environment) {
        throw new AppError(
          409,
          "wrong_environment",
          `This connection belongs to the ${item.environment} environment.`,
        );
      }
      let accessToken: string;
      try {
        accessToken = cipher.decrypt(item.accessTokenEncrypted, item.plaidItemId);
      } catch {
        throw new AppError(
          500,
          "token_unreadable",
          "The saved connection token cannot be read, so the encryption key may have changed. Disconnect and reconnect this institution.",
        );
      }

      // Refresh accounts first: picks up new accounts and current balances before the transactions.
      const gatewayAccounts = await gateway.getAccounts(accessToken);
      store(() => upsertItemAccounts(db, item.id, gatewayAccounts, iso()));
      const accountIds = accountIdsByPlaidId(db, item.id);

      const saveCursor = (cursor: string | null): void => {
        db.update(plaidItems)
          .set({ syncCursor: cursor, updatedAt: iso() })
          .where(eq(plaidItems.id, item.id))
          .run();
      };

      const applyPage = (page: TransactionSyncPage): void => {
        const stamp = iso();
        // One database transaction per page: the changes and the new cursor commit together, so
        // the cursor never moves past changes that were not stored.
        const outcome = db.transaction((tx) => {
          const added: string[] = [];
          const modified: string[] = [];
          const touched: number[] = [];
          const apply = (t: GatewayTransaction): void => {
            const accountId = accountIds.get(t.accountId);
            if (accountId === undefined) return; // an account we do not track (for example closed)
            const result = upsertTransaction(tx, accountId, t, stamp);
            (result.kind === "added" ? added : modified).push(t.transactionId);
            touched.push(result.id);
          };
          page.added.forEach(apply);
          page.modified.forEach(apply);
          // Categorize what just arrived or changed, in the same database transaction as the
          // page. Categories the user chose by hand are never touched.
          applyRules(tx, touched);
          const removed = removeTransactions(tx, page.removedIds);
          tx.update(plaidItems)
            .set({ syncCursor: page.nextCursor, updatedAt: stamp })
            .where(eq(plaidItems.id, item.id))
            .run();
          return { added, modified, removed };
        });
        outcome.added.forEach((id) => addedIds.add(id));
        outcome.modified.forEach((id) => {
          if (!addedIds.has(id)) modifiedIds.add(id);
        });
        outcome.removed.forEach((id) => removedIds.add(id));
      };

      const startCursor = item.syncCursor;
      let cursor = startCursor;
      let restarts = 0;
      let reconcile = false;
      const seen = new Map<string, string>(); // provider ID -> date, only used when reconciling
      const hasInvestments = store(() => hasInvestmentAccounts(db, item.id));

      for (;;) {
        let page: TransactionSyncPage;
        try {
          page = await gateway.syncTransactions(accessToken, cursor);
        } catch (error) {
          const failure = toGatewayError(error);
          if (PRODUCT_UNAVAILABLE.has(failure.code) && hasInvestments) {
            // A brokerage or retirement plan has no bank transactions; its holdings come next.
            break;
          }
          if (
            failure.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
            restarts < MAX_RESTARTS
          ) {
            // Data changed while paging: start the whole pass again from where it began.
            // Re-applying pages is safe because storing a transaction is idempotent.
            restarts += 1;
            cursor = startCursor;
            saveCursor(startCursor);
            continue;
          }
          if (failure.code === "INVALID_CURSOR" && !reconcile) {
            // The saved position is no longer valid (for example after a very long gap). Pull
            // everything again and reconcile, instead of failing forever.
            reconcile = true;
            cursor = null;
            saveCursor(null);
            seen.clear();
            continue;
          }
          throw failure;
        }
        store(() => applyPage(page));
        if (reconcile) {
          for (const t of [...page.added, ...page.modified]) seen.set(t.transactionId, t.date);
        }
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }

      if (reconcile && seen.size > 0) {
        // After a full re-pull, delete local transactions the provider no longer returns, but only
        // within the date range it did return (older history is simply outside its window).
        const earliest = [...seen.values()].sort()[0]!;
        const ids = [...accountIds.values()];
        const stale = db
          .select({ id: transactions.id, plaidId: transactions.plaidTransactionId })
          .from(transactions)
          .where(and(inArray(transactions.accountId, ids), gte(transactions.date, earliest)))
          .all()
          .filter((row) => row.plaidId && !seen.has(row.plaidId));
        if (stale.length > 0) {
          db.delete(transactions)
            .where(
              inArray(
                transactions.id,
                stale.map((row) => row.id),
              ),
            )
            .run();
          stale.forEach((row) => removedIds.add(row.plaidId!));
        }
      }

      if (hasInvestments) {
        const holdingsNow = await optionalInvestmentData(() =>
          gateway.getInvestmentHoldings(accessToken),
        );
        if (holdingsNow) {
          store(() =>
            db.transaction((tx) => applyHoldingsSnapshot(tx, item.id, holdingsNow, iso())),
          );
        }
        const today = iso().slice(0, 10);
        const since = item.lastSuccessfulSyncAt
          ? addDays(item.lastSuccessfulSyncAt.slice(0, 10), -INVESTMENT_OVERLAP_DAYS)
          : addDays(today, -INVESTMENT_FIRST_PULL_DAYS);
        const activity = await optionalInvestmentData(() =>
          gateway.getInvestmentTransactions(accessToken, since, today),
        );
        if (activity) {
          store(() =>
            db.transaction((tx) => applyInvestmentTransactions(tx, item.id, activity, iso())),
          );
        }
      }

      const observedAt = iso();
      store(() =>
        db.transaction((tx) => {
          recordObservations(tx, item.id, gatewayAccounts, observedAt);
          tx.update(plaidItems)
            .set({
              status: "active",
              lastErrorCode: null,
              lastErrorMessage: null,
              lastSuccessfulSyncAt: observedAt,
              updatedAt: observedAt,
            })
            .where(eq(plaidItems.id, item.id))
            .run();
        }),
      );
      return finish("success");
    } catch (error) {
      if (error instanceof AppError) {
        return finish("error", { errorCode: error.code, errorMessage: error.message });
      }
      if (error instanceof StorageError) {
        // A problem on this computer, not with Plaid: say so, and do not touch the connection.
        return finish("error", {
          errorCode: "storage_error",
          errorMessage: `The synced data could not be saved (${error.message}). Nothing was lost; the next sync resumes from the last saved point.`,
        });
      }
      const failure = toGatewayError(error);
      if (failure.code === "NETWORK_ERROR") {
        // Offline is normal for this app: nothing is marked broken and the cooldown is untouched.
        return finish("offline", { errorCode: failure.code, errorMessage: failure.message });
      }
      if (failure.code === "PRODUCT_NOT_READY") {
        return finish("pending", {
          errorCode: failure.code,
          errorMessage: "Your bank's transactions are not ready yet. Try again in a few minutes.",
        });
      }
      if (REAUTH_ERROR_CODES.has(failure.code)) markItemProblem(item.id, failure);
      return finish("error", { errorCode: failure.code, errorMessage: failure.message });
    }
  }

  /** Syncs one connection, or joins the sync already running for it. */
  function syncItem(itemId: number, trigger: SyncTrigger): Promise<SyncRunSummary> {
    const running = inFlight.get(itemId);
    if (running) return running;
    const promise = runSync(itemId, trigger).finally(() => inFlight.delete(itemId));
    inFlight.set(itemId, promise);
    return promise;
  }

  function isDue(item: ItemRow, trigger: SyncTrigger): boolean {
    const settings = getSettings(db); // read each time, so edits apply immediately
    const nowMs = now().getTime();
    const lastSuccess = item.lastSuccessfulSyncAt ? Date.parse(item.lastSuccessfulSyncAt) : null;
    if (trigger === "interval") {
      if (settings.autoSyncIntervalMinutes <= 0) return false;
      const interval = settings.autoSyncIntervalMinutes * MINUTE;
      const lastAttempt = lastIntervalAttempt.get(item.id) ?? 0;
      const retryGap = Math.max(interval, MIN_RETRY_MINUTES * MINUTE);
      return (
        (lastSuccess === null || nowMs - lastSuccess >= interval) && nowMs - lastAttempt >= retryGap
      );
    }
    // Launch: due when never synced, or the cooldown (a failed attempt does not reset it) is over.
    return lastSuccess === null || nowMs - lastSuccess >= settings.syncCooldownMinutes * MINUTE;
  }

  function itemsForActiveEnvironment(): ItemRow[] {
    const environment = getSettings(db).plaidEnvironment;
    return db
      .select()
      .from(plaidItems)
      .where(eq(plaidItems.environment, environment))
      .orderBy(asc(plaidItems.id))
      .all();
  }

  /** Syncs every connection that is due (or all of them when `force` is set, as the button does). */
  async function syncAll(options: {
    trigger: SyncTrigger;
    force?: boolean;
  }): Promise<SyncAllResult> {
    const result: SyncAllResult = { runs: [], skipped: [] };
    for (const item of itemsForActiveEnvironment()) {
      if (!options.force) {
        if (item.status === "login_required") {
          result.skipped.push({
            itemId: item.id,
            institutionName: item.institutionName,
            reason: "needs_signin",
          });
          continue;
        }
        if (!isDue(item, options.trigger)) {
          result.skipped.push({
            itemId: item.id,
            institutionName: item.institutionName,
            reason: options.trigger === "interval" ? "interval" : "cooldown",
          });
          continue;
        }
      }
      if (options.trigger === "interval") lastIntervalAttempt.set(item.id, now().getTime());
      result.runs.push(await syncItem(item.id, options.trigger));
    }
    return result;
  }

  return {
    syncItem,
    syncAll,

    /** Runs when the app starts. Respects the cooldown, and cleans up after an interrupted run. */
    runLaunchSync(): Promise<SyncAllResult> {
      db.update(syncRuns)
        .set({
          status: "error",
          finishedAt: iso(),
          errorCode: "interrupted",
          errorMessage: "The app closed during this sync.",
        })
        .where(eq(syncRuns.status, "running"))
        .run();
      return syncAll({ trigger: "launch" });
    },

    /** Called on a timer while the app is open; does nothing unless the interval setting is on. */
    runIntervalTick(): Promise<SyncAllResult> {
      return syncAll({ trigger: "interval" });
    },

    status() {
      const settings = getSettings(db);
      const items = itemsForActiveEnvironment().map((item) => {
        const lastRun = db
          .select({ id: syncRuns.id })
          .from(syncRuns)
          .where(eq(syncRuns.plaidItemId, item.id))
          .orderBy(desc(syncRuns.id))
          .get();
        const last = item.lastSuccessfulSyncAt ? Date.parse(item.lastSuccessfulSyncAt) : null;
        const after = (minutes: number): string | null =>
          last === null ? null : new Date(last + minutes * MINUTE).toISOString();
        return {
          itemId: item.id,
          institutionName: item.institutionName,
          connectionStatus: item.status,
          lastSuccessfulSyncAt: item.lastSuccessfulSyncAt,
          /** When a launch sync would next run, per the cooldown setting. */
          launchSyncEligibleAt: after(settings.syncCooldownMinutes),
          /** When the timer would next sync it, if the interval setting is on. */
          nextAutoSyncAt:
            settings.autoSyncIntervalMinutes > 0 ? after(settings.autoSyncIntervalMinutes) : null,
          syncing: inFlight.has(item.id),
          lastRun: lastRun ? summarize(lastRun.id) : null,
        };
      });
      return {
        environment: settings.plaidEnvironment,
        syncing: inFlight.size > 0,
        cooldownMinutes: settings.syncCooldownMinutes,
        intervalMinutes: settings.autoSyncIntervalMinutes,
        items,
      };
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
