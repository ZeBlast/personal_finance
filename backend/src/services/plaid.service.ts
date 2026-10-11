import { and, asc, eq, ne } from "drizzle-orm";
import { plaidItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import {
  ITEM_GONE_ERROR_CODES,
  PlaidGatewayError,
  REAUTH_ERROR_CODES,
  type LinkKind,
  type PlaidGateway,
} from "../plaid/gateway.js";
import { toGatewayError } from "../plaid/real-gateway.js";
import type { GatewayProvider } from "../plaid/provider.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts, upsertItemAccounts, type AccountSummary } from "./account.service.js";
import type { TokenCipher } from "./crypto.js";
import { getSettings } from "./settings.service.js";

/** One local user; Plaid only needs a stable identifier. */
const LOCAL_USER_ID = "personal-finance-local-user";

type ItemRow = typeof plaidItems.$inferSelect;

/** An Item as the API shows it. The encrypted access token is deliberately not part of this. */
export interface ItemSummary {
  id: number;
  institutionId: string | null;
  institutionName: string;
  /** The institution's logo (an image data URL), when it has been looked up. */
  logo: string | null;
  environment: string;
  status: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  daysRequested: number;
  lastSuccessfulSyncAt: string | null;
  createdAt: string;
  /** Belongs to another install of the app (a development copy): read-only here. */
  borrowed: boolean;
  accounts: AccountSummary[];
}

export interface ExchangeResult {
  item: ItemSummary;
  /** Present when the connection was saved but something after linking failed. */
  warning?: string;
  /** Present when another connection to the same institution already exists. */
  duplicateOfItemId?: number;
}

interface Deps {
  db: AppDb;
  cipher: TokenCipher;
  getGateway: GatewayProvider;
}

/** Turns a Plaid failure into an error the API can return, without leaking provider details. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const failure = toGatewayError(error);
  if (failure.code === "NETWORK_ERROR") {
    return new AppError(503, "plaid_unreachable", failure.message);
  }
  if (REAUTH_ERROR_CODES.has(failure.code)) {
    return new AppError(409, "reauth_required", failure.message);
  }
  return new AppError(502, "plaid_error", failure.message);
}

function statusFor(failure: PlaidGatewayError): "login_required" | "error" {
  return REAUTH_ERROR_CODES.has(failure.code) ? "login_required" : "error";
}

export function createPlaidService({ db, cipher, getGateway }: Deps) {
  const now = (): string => new Date().toISOString();

  function summarize(row: ItemRow): ItemSummary {
    return {
      id: row.id,
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      logo: row.institutionLogo,
      environment: row.environment,
      status: row.status,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      daysRequested: row.daysRequested,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      createdAt: row.createdAt,
      borrowed: row.borrowed,
      accounts: listAccounts(db, row.id),
    };
  }

  /**
   * A borrowed connection is read-only. Anything that would change the connection at Plaid
   * (disconnecting it, signing in again, repairing it) is refused, because the access token is
   * shared with the app that really owns it: disconnecting here would disconnect it there too.
   */
  function refuseIfBorrowed(row: ItemRow, what: string): void {
    if (!row.borrowed) return;
    throw new AppError(
      409,
      "borrowed_connection",
      `${row.institutionName} is borrowed from your real app, so it cannot be ${what} from here. Do that in the real app.`,
    );
  }

  function requireItem(id: number): ItemRow {
    const row = db.select().from(plaidItems).where(eq(plaidItems.id, id)).get();
    if (!row) throw notFound("That connection");
    return row;
  }

  /** The matching gateway for an Item, refusing to mix environments. */
  function gatewayFor(row: ItemRow): PlaidGateway {
    const gateway = getGateway();
    if (gateway.environment !== row.environment) {
      throw new AppError(
        409,
        "wrong_environment",
        `This connection belongs to the ${row.environment} environment. Switch to it in Settings first.`,
      );
    }
    return gateway;
  }

  function readToken(row: ItemRow): string {
    try {
      return cipher.decrypt(row.accessTokenEncrypted, row.plaidItemId);
    } catch {
      throw new AppError(
        500,
        "token_unreadable",
        "The saved connection token cannot be read, so the encryption key may have changed. Disconnect and reconnect this institution.",
      );
    }
  }

  function recordProblem(row: ItemRow, failure: PlaidGatewayError): void {
    db.update(plaidItems)
      .set({
        status: statusFor(failure),
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
        updatedAt: now(),
      })
      .where(eq(plaidItems.id, row.id))
      .run();
  }

  function markHealthy(row: ItemRow): void {
    db.update(plaidItems)
      .set({ status: "active", lastErrorCode: null, lastErrorMessage: null, updatedAt: now() })
      .where(eq(plaidItems.id, row.id))
      .run();
  }

  const service = {
    async createLinkToken(kind: LinkKind = "banking") {
      const gateway = getGateway();
      try {
        const token = await gateway.createLinkToken({
          kind,
          userId: LOCAL_USER_ID,
          daysRequested: getSettings(db).plaidDaysRequested,
        });
        return { ...token, environment: gateway.environment };
      } catch (error) {
        throw toAppError(error);
      }
    },

    async exchange(
      publicToken: string,
      hint?: { id?: string | undefined; name?: string | undefined },
    ): Promise<ExchangeResult> {
      const gateway = getGateway();
      let exchanged;
      try {
        exchanged = await gateway.exchangePublicToken(publicToken);
      } catch (error) {
        throw toAppError(error);
      }

      // Save the token before anything else can fail. Every Production access token counts
      // against the Trial plan's Item limit, so losing one would cost a slot.
      const created = now();
      let row: ItemRow;
      try {
        row = db
          .insert(plaidItems)
          .values({
            plaidItemId: exchanged.itemId,
            environment: gateway.environment,
            institutionId: hint?.id ?? null,
            institutionName: hint?.name ?? "Linked institution",
            accessTokenEncrypted: cipher.encrypt(exchanged.accessToken, exchanged.itemId),
            status: "active",
            daysRequested: getSettings(db).plaidDaysRequested,
            createdAt: created,
            updatedAt: created,
          })
          .returning()
          .get();
      } catch {
        // Could not save it, so do not leave an Item behind that the app can never reach.
        await gateway.removeItem(exchanged.accessToken).catch(() => undefined);
        throw new AppError(
          500,
          "save_failed",
          "The connection could not be saved. Please try again.",
        );
      }

      let warning: string | undefined;
      try {
        const status = await gateway.getItem(exchanged.accessToken);
        const institutionId = status.institutionId ?? hint?.id ?? null;
        const institutionName = institutionId
          ? await gateway.getInstitutionName(institutionId).catch(() => null)
          : null;
        const gatewayAccounts = await gateway.getAccounts(exchanged.accessToken);
        db.transaction((tx) => {
          tx.update(plaidItems)
            .set({
              institutionId,
              institutionName: institutionName ?? hint?.name ?? row.institutionName,
              updatedAt: now(),
            })
            .where(eq(plaidItems.id, row.id))
            .run();
          upsertItemAccounts(tx, row.id, gatewayAccounts, now());
        });
      } catch (error) {
        const failure = toGatewayError(error);
        recordProblem(row, failure);
        warning = `Connected, but the accounts could not be loaded yet: ${failure.message}`;
      }

      // The institution's logo, for showing which bank things happened at (best effort).
      if (warning === undefined) await service.refreshBranding().catch(() => 0);

      const saved = requireItem(row.id);
      const duplicate = saved.institutionId
        ? db
            .select({ id: plaidItems.id })
            .from(plaidItems)
            .where(
              and(
                eq(plaidItems.environment, saved.environment),
                eq(plaidItems.institutionId, saved.institutionId),
                ne(plaidItems.id, saved.id),
              ),
            )
            .get()
        : undefined;

      return {
        item: summarize(saved),
        ...(warning ? { warning } : {}),
        ...(duplicate ? { duplicateOfItemId: duplicate.id } : {}),
      };
    },

    /**
     * Looks up the logo and brand color of each connection's institution that has not been looked
     * up yet (or not for a month), in the environment in use. Best effort: a failure leaves it for
     * next time. Returns how many were updated.
     */
    async refreshBranding(options: { force?: boolean } = {}): Promise<number> {
      const gateway = getGateway();
      const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const rows = db
        .select()
        .from(plaidItems)
        .where(eq(plaidItems.environment, gateway.environment))
        .all()
        .filter(
          (r) =>
            r.institutionId !== null &&
            (options.force || r.brandingCheckedAt === null || r.brandingCheckedAt < monthAgo),
        );
      let updated = 0;
      for (const row of rows) {
        try {
          const branding = await gateway.getInstitutionBranding(row.institutionId!);
          db.update(plaidItems)
            .set({
              institutionLogo: branding.logo,
              institutionColor: branding.color,
              brandingCheckedAt: now(),
            })
            .where(eq(plaidItems.id, row.id))
            .run();
          updated += 1;
        } catch {
          // Try again next time.
        }
      }
      return updated;
    },

    /** Each connection's institution, with its logo and color when known (current environment). */
    institutions(): Array<{
      itemId: number;
      institutionName: string;
      logo: string | null;
      color: string | null;
    }> {
      // From the settings, not the gateway: listing logos must work even when Plaid is not set up.
      const environment = getSettings(db).plaidEnvironment;
      return db
        .select({
          itemId: plaidItems.id,
          institutionName: plaidItems.institutionName,
          logo: plaidItems.institutionLogo,
          color: plaidItems.institutionColor,
        })
        .from(plaidItems)
        .where(eq(plaidItems.environment, environment))
        .all();
    },

    /** Plaid's own ID for an Item; internal use (demo tools), not exposed in API summaries. */
    plaidItemIdOf(id: number): string {
      return requireItem(id).plaidItemId;
    },

    /** Connections for the environment currently selected in Settings. */
    list(): ItemSummary[] {
      const environment = getSettings(db).plaidEnvironment;
      return db
        .select()
        .from(plaidItems)
        .where(eq(plaidItems.environment, environment))
        .orderBy(asc(plaidItems.id))
        .all()
        .map(summarize);
    },

    async createUpdateLinkToken(id: number) {
      const row = requireItem(id);
      refuseIfBorrowed(row, "signed in again");
      const gateway = gatewayFor(row);
      try {
        const token = await gateway.createLinkToken({
          userId: LOCAL_USER_ID,
          daysRequested: row.daysRequested,
          updateAccessToken: readToken(row),
        });
        return { ...token, environment: gateway.environment };
      } catch (error) {
        throw toAppError(error);
      }
    },

    /** Asks Plaid whether the connection is healthy and records the answer. */
    async check(id: number): Promise<ItemSummary> {
      const row = requireItem(id);
      const gateway = gatewayFor(row);
      // Read the token first: failing to decrypt it is our problem, not evidence that the
      // connection is broken, so it must not be recorded as a connection error below.
      const accessToken = readToken(row);
      try {
        const status = await gateway.getItem(accessToken);
        if (status.error) {
          recordProblem(
            row,
            new PlaidGatewayError(status.error.code, "ITEM_ERROR", status.error.message),
          );
        } else {
          markHealthy(row);
        }
      } catch (error) {
        const failure = toGatewayError(error);
        // A network blip says nothing about the connection itself, so leave its status alone.
        if (failure.code !== "NETWORK_ERROR") recordProblem(row, failure);
        else throw toAppError(failure);
      }
      // While at it, the institution's logo, if it was never found (best effort).
      if (!row.institutionLogo && row.institutionId) {
        try {
          const branding = await gateway.getInstitutionBranding(row.institutionId);
          db.update(plaidItems)
            .set({
              institutionLogo: branding.logo,
              institutionColor: branding.color ?? row.institutionColor,
              brandingCheckedAt: now(),
            })
            .where(eq(plaidItems.id, row.id))
            .run();
        } catch {
          // No logo this time; the connection check itself stands.
        }
      }
      return summarize(requireItem(id));
    },

    async reauthenticated(id: number, publicToken: string | undefined): Promise<ItemSummary> {
      const row = requireItem(id);
      refuseIfBorrowed(row, "signed in again");
      const gateway = gatewayFor(row);
      try {
        await gateway.completeReauthentication(readToken(row), publicToken);
      } catch (error) {
        throw toAppError(error);
      }
      return this.check(id);
    },

    /**
     * Disconnects at Plaid and deletes the local connection and its accounts. If Plaid cannot be
     * reached the local data is kept (so the Item is not orphaned) unless `force` is set.
     */
    async remove(id: number, force: boolean): Promise<void> {
      const row = requireItem(id);
      if (row.borrowed) {
        // Only ever the local copy: Plaid is never told, so the real app's connection is untouched.
        db.delete(plaidItems).where(eq(plaidItems.id, id)).run(); // accounts cascade
        return;
      }
      try {
        const gateway = gatewayFor(row);
        await gateway.removeItem(readToken(row));
      } catch (error) {
        const failure = error instanceof AppError ? undefined : toGatewayError(error);
        // "Item not found" means it is already gone on Plaid's side, which is the goal anyway.
        const alreadyGone = failure !== undefined && ITEM_GONE_ERROR_CODES.has(failure.code);
        if (!alreadyGone && !force) {
          throw error instanceof AppError
            ? error
            : new AppError(
                502,
                "disconnect_failed",
                `Could not disconnect at Plaid: ${failure?.message ?? "unknown error"} Nothing was deleted. You can retry, or delete the local copy only.`,
              );
        }
      }
      db.delete(plaidItems).where(eq(plaidItems.id, id)).run(); // accounts cascade
    },
  };
  return service;
}

export type PlaidService = ReturnType<typeof createPlaidService>;
