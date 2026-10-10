import { eq } from "drizzle-orm";
import { subscriptionReviews } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { recurringReport, type RecurringSeries } from "./recurring.service.js";

/**
 * A review of recurring charges (subscriptions, memberships, bills): what each costs a year, which
 * went up in price, which seem to have stopped, and the user's own decision about each (keep it,
 * mean to cancel it, cancelled).
 */

export const SUBSCRIPTION_STATUSES = ["keep", "cancel", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface Subscription extends RecurringSeries {
  yearlyMinor: number;
  review: { status: SubscriptionStatus; note: string | null } | null;
  /** Still being charged after the user marked it cancelled. */
  chargedAfterCancel: boolean;
}

/** Something about a recurring charge worth a look. */
export interface RecurringChange {
  key: string;
  merchant: string;
  kind: "price_up" | "price_down" | "new" | "charged_after_cancel";
  /** When it happened: the charge at the new price, the first charge, the charge after cancelling. */
  date: string;
  fromMinor: number | null;
  toMinor: number;
  /** The change per year at the usual schedule (for a new charge: what it costs a year). */
  yearlyDeltaMinor: number;
}

/** Price changes in the last four months, and recurring charges that started in the last three. */
export const PRICE_CHANGE_WINDOW_DAYS = 120;
export const NEW_CHARGE_WINDOW_DAYS = 90;

/**
 * What changed recently among recurring charges, newest first: a price going up (or down), a
 * recurring charge that started, and one still charged after being marked cancelled.
 */
export function recurringChanges(subscriptions: Subscription[], today: string): RecurringChange[] {
  const changes: RecurringChange[] = [];
  const priceSince = addDays(today, -PRICE_CHANGE_WINDOW_DAYS);
  const newSince = addDays(today, -NEW_CHARGE_WINDOW_DAYS);
  for (const s of subscriptions) {
    if (s.dismissed || s.status !== "active") continue;
    const perYear = s.typicalAmountMinor > 0 ? s.yearlyMinor / s.typicalAmountMinor : 0;
    if (s.chargedAfterCancel) {
      changes.push({
        key: s.key,
        merchant: s.merchant,
        kind: "charged_after_cancel",
        date: s.lastDate,
        fromMinor: null,
        toMinor: s.lastAmountMinor,
        yearlyDeltaMinor: s.yearlyMinor,
      });
    }
    if (s.priceChange && s.priceChange.date >= priceSince) {
      const delta = s.priceChange.toMinor - s.priceChange.fromMinor;
      changes.push({
        key: s.key,
        merchant: s.merchant,
        kind: delta > 0 ? "price_up" : "price_down",
        date: s.priceChange.date,
        fromMinor: s.priceChange.fromMinor,
        toMinor: s.priceChange.toMinor,
        yearlyDeltaMinor: Math.round(delta * perYear),
      });
    }
    if (s.firstDate >= newSince && s.review?.status !== "keep") {
      changes.push({
        key: s.key,
        merchant: s.merchant,
        kind: "new",
        date: s.firstDate,
        fromMinor: null,
        toMinor: s.typicalAmountMinor,
        yearlyDeltaMinor: s.yearlyMinor,
      });
    }
  }
  return changes.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}

export interface SubscriptionReview {
  currency: string;
  subscriptions: Subscription[];
  /** Recent changes worth a look: price changes, new recurring charges, charges after cancelling. */
  changes: RecurringChange[];
  totals: { monthlyMinor: number; yearlyMinor: number; toCancelYearlyMinor: number };
}

export function subscriptionReview(
  db: AppDb,
  options: { today?: string | undefined } = {},
): SubscriptionReview {
  const report = recurringReport(db, { today: options.today });
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const reviews = new Map(
    db
      .select()
      .from(subscriptionReviews)
      .all()
      .map((r) => [r.key, r]),
  );
  const subscriptions = report.series
    .filter((s) => s.direction === "out")
    .map((s): Subscription => {
      const r = reviews.get(s.key);
      return {
        ...s,
        yearlyMinor: s.perMonthMinor * 12,
        review: r ? { status: r.status as SubscriptionStatus, note: r.note } : null,
        chargedAfterCancel: r?.status === "cancelled" && s.lastDate > r.updatedAt.slice(0, 10),
      };
    })
    // Biggest yearly cost first; ones that stopped go last.
    .sort(
      (a, b) =>
        Number(a.status === "lapsed") - Number(b.status === "lapsed") ||
        b.yearlyMinor - a.yearlyMinor,
    );
  const live = subscriptions.filter(
    (s) => s.status === "active" && s.review?.status !== "cancelled",
  );
  return {
    currency: report.currency,
    subscriptions,
    changes: recurringChanges(subscriptions, today),
    totals: {
      monthlyMinor: live.reduce((n, s) => n + s.perMonthMinor, 0),
      yearlyMinor: live.reduce((n, s) => n + s.yearlyMinor, 0),
      toCancelYearlyMinor: live
        .filter((s) => s.review?.status === "cancel")
        .reduce((n, s) => n + s.yearlyMinor, 0),
    },
  };
}

export function setSubscriptionReview(
  db: AppDb,
  key: string,
  input: { merchant: string; status: SubscriptionStatus | null; note?: string | null | undefined },
  now: string = new Date().toISOString(),
): void {
  if (input.status === null) {
    db.delete(subscriptionReviews).where(eq(subscriptionReviews.key, key)).run();
    return;
  }
  if (!SUBSCRIPTION_STATUSES.includes(input.status)) {
    throw new AppError(400, "invalid_status", "Choose keep, cancel, or cancelled.");
  }
  const values = {
    merchant: input.merchant,
    status: input.status,
    note: input.note?.trim() ? input.note.trim() : null,
    updatedAt: now,
  };
  db.insert(subscriptionReviews)
    .values({ key, ...values })
    .onConflictDoUpdate({ target: subscriptionReviews.key, set: values })
    .run();
}
