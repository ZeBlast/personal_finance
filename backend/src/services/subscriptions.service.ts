import { eq } from "drizzle-orm";
import { subscriptionReviews } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
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

export interface SubscriptionReview {
  currency: string;
  subscriptions: Subscription[];
  totals: { monthlyMinor: number; yearlyMinor: number; toCancelYearlyMinor: number };
}

export function subscriptionReview(
  db: AppDb,
  options: { today?: string | undefined } = {},
): SubscriptionReview {
  const report = recurringReport(db, { today: options.today });
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
