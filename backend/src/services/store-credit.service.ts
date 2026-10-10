import { eq } from "drizzle-orm";
import { accounts } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import {
  createManualTransaction,
  deleteManualTransaction,
  STORE_CREDIT_SUBTYPE,
} from "./manual-transaction.service.js";
import type { TransactionDto } from "./transaction.service.js";

/**
 * Store credit (a gift card, or dollar credits with one business): an account kept by hand whose
 * balance is the credit left.
 *
 * Credits are not real dollars, so nothing on these accounts counts toward income, spending,
 * budgets, net worth, taxes, or forecasts (see account-scope.ts); they only count in the account's
 * own balance and history. Buying a gift card is the real spending, on the account that paid.
 * A purchase paid partly with real money adds that part to the account that paid it, where it
 * counts as usual.
 */

const formatDollars = (minor: number): string =>
  "$" +
  (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface StoreCreditAccount {
  id: number;
  name: string;
  balanceMinor: number;
}

function requireStoreCredit(db: Pick<AppDb, "select">, accountId: number): StoreCreditAccount {
  const row = db
    .select({
      id: accounts.id,
      name: accounts.name,
      subtype: accounts.subtype,
      isManual: accounts.isManual,
      balanceMinor: accounts.currentBalanceMinor,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!row) throw notFound("That account");
  if (!row.isManual || row.subtype !== STORE_CREDIT_SUBTYPE) {
    throw new AppError(409, "not_store_credit", "That is not a store credit or gift card account.");
  }
  return { id: row.id, name: row.name, balanceMinor: row.balanceMinor ?? 0 };
}

export interface AddCreditsInput {
  date: string;
  amountMinor: number;
  /** Where the credits came from, such as "Gift from Sam" or "Reload"; shown as the merchant. */
  description?: string | null | undefined;
  notes?: string | null | undefined;
}

export function addCredits(
  db: AppDb,
  accountId: number,
  input: AddCreditsInput,
  now: string,
): TransactionDto {
  const account = requireStoreCredit(db, accountId);
  return createManualTransaction(
    db,
    {
      accountId: account.id,
      date: input.date,
      merchant: input.description?.trim() || `${account.name} credits added`,
      amountMinor: input.amountMinor,
      direction: "in",
      notes: input.notes ?? null,
    },
    now,
  );
}

export interface UseCreditsInput {
  date: string;
  merchant?: string | null | undefined;
  /** The whole price. */
  totalMinor: number;
  /** How much of it the credits paid; the rest is real money. */
  creditMinor: number;
  categoryId?: number | null | undefined;
  /**
   * Where the rest was paid from: an account kept by hand (a transaction is added there too), or
   * null when it was a connected account or card (the bank will record that part).
   */
  restAccountId?: number | null | undefined;
  notes?: string | null | undefined;
}

export interface UseCreditsResult {
  credit: TransactionDto;
  rest: TransactionDto | null;
}

export function useCredits(
  db: AppDb,
  accountId: number,
  input: UseCreditsInput,
  now: string,
): UseCreditsResult {
  const account = requireStoreCredit(db, accountId);
  const { totalMinor, creditMinor } = input;
  if (!Number.isInteger(totalMinor) || totalMinor < 1) {
    throw new AppError(400, "invalid_amount", "Enter the whole price as a positive amount.");
  }
  if (!Number.isInteger(creditMinor) || creditMinor < 1 || creditMinor > totalMinor) {
    throw new AppError(
      400,
      "invalid_amount",
      "The credits used must be more than zero and no more than the whole price.",
    );
  }
  if (creditMinor > account.balanceMinor) {
    throw new AppError(
      409,
      "not_enough_credit",
      `${account.name} has only ${formatDollars(account.balanceMinor)} of credit left.`,
    );
  }
  const restMinor = totalMinor - creditMinor;
  if (input.restAccountId != null) {
    if (input.restAccountId === account.id) {
      throw new AppError(400, "invalid_account", "Choose another account for the rest.");
    }
    if (restMinor === 0) {
      throw new AppError(
        400,
        "invalid_amount",
        "The credits paid the whole price; there is no rest.",
      );
    }
  }
  const merchant = input.merchant?.trim() || account.name;
  let restName = "a connected account or card";
  if (input.restAccountId != null) {
    const other = db
      .select({ name: accounts.name, isManual: accounts.isManual, type: accounts.type })
      .from(accounts)
      .where(eq(accounts.id, input.restAccountId))
      .get();
    if (!other || !other.isManual || (other.type !== "depository" && other.type !== "credit")) {
      throw new AppError(
        400,
        "invalid_account",
        "The rest can be added to an account you keep by hand. For a connected account or card, leave it to the bank.",
      );
    }
    restName = other.name;
  }
  const split =
    restMinor > 0
      ? `Part of a ${formatDollars(totalMinor)} purchase: ${formatDollars(creditMinor)} from ${account.name} credits, ${formatDollars(restMinor)} from ${restName}.`
      : null;
  const notes = [split, input.notes?.trim() || null].filter(Boolean).join("\n") || null;

  const credit = createManualTransaction(
    db,
    {
      accountId: account.id,
      date: input.date,
      merchant,
      amountMinor: creditMinor,
      direction: "out",
      categoryId: input.categoryId ?? null,
      notes,
    },
    now,
  );
  let rest: TransactionDto | null = null;
  if (input.restAccountId != null && restMinor > 0) {
    try {
      rest = createManualTransaction(
        db,
        {
          accountId: input.restAccountId,
          date: input.date,
          merchant,
          amountMinor: restMinor,
          direction: "out",
          categoryId: input.categoryId ?? null,
          notes,
        },
        now,
      );
    } catch (error) {
      // Both parts, or neither.
      deleteManualTransaction(db, credit.id);
      throw error;
    }
  }
  return { credit, rest };
}
