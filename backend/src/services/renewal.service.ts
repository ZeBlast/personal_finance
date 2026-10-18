import { and, eq, sql } from "drizzle-orm";
import {
  renewalDismissals,
  subscriptionPaymentExclusions,
  trackedSubscriptions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { recurringReport } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";
import { addMonthsToDay, listTrackedSubscriptions } from "./tracked-subscriptions.service.js";

/**
 * A subscription's payments over time, and the renewal inbox: what is about to renew, end or cost
 * more, so it can be dealt with before the money goes.
 */

export interface SubscriptionPayment {
  id: number;
  date: string;
  merchant: string;
  accountName: string;
  amountMinor: number;
  /** The user said this one is not a payment of the subscription. */
  excluded: boolean;
  /** The amount differs from the payment before (excluded ones are skipped). */
  changeMinor: number | null;
}

export interface PaymentHistory {
  subscriptionId: number;
  /** What the merchant was matched against, and where that came from. */
  match: string;
  matchSource: "set" | "found" | "name";
  payments: SubscriptionPayment[];
  totalMinor: number;
}

const HISTORY_YEARS = 3;

function requireSubscription(db: AppDb, id: number) {
  const row = db.select().from(trackedSubscriptions).where(eq(trackedSubscriptions.id, id)).get();
  if (!row) throw notFound("That subscription");
  return row;
}

/** Newest first: what was paid to the subscription's merchant over the last three years. */
export function paymentHistory(
  db: AppDb,
  id: number,
  today = new Date().toISOString().slice(0, 10),
): PaymentHistory {
  const row = requireSubscription(db, id);
  let match = row.paymentMatch?.trim() ?? "";
  let matchSource: PaymentHistory["matchSource"] = "set";
  if (!match && row.recurringKey) {
    const series = recurringReport(db, { today }).series.find((s) => s.key === row.recurringKey);
    if (series) {
      match = series.merchant;
      matchSource = "found";
    }
  }
  if (!match) {
    match = row.name;
    matchSource = "name";
  }
  const like = `%${match.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const from = addDays(today, -365 * HISTORY_YEARS);
  const environment = getSettings(db).plaidEnvironment;
  const rows = db.all<{
    id: number;
    date: string;
    merchant: string;
    accountName: string;
    amountMinor: number;
    excluded: number;
  }>(sql`
    select t.id, t.date, coalesce(t.merchant_name_user, t.merchant_name, t.name) as merchant,
      a.name as accountName, t.amount_minor as amountMinor,
      exists (select 1 from subscription_payment_exclusions x
        where x.subscription_id = ${id} and x.transaction_id = t.id) as excluded
    from transactions t
    join accounts a on a.id = t.account_id
    left join plaid_items p on p.id = a.plaid_item_id
    where t.amount_minor > 0 and t.is_transfer = 0 and t.date >= ${from}
      and (p.environment = ${environment} or a.plaid_item_id is null)
      and lower(coalesce(t.merchant_name_user, t.merchant_name, t.name)) like ${like} escape '\\'
    order by t.date desc, t.id desc
    limit 400
  `);
  const payments: SubscriptionPayment[] = rows.map((r) => ({
    ...r,
    excluded: Boolean(r.excluded),
    changeMinor: null,
  }));
  // Each kept payment against the kept one before it.
  const kept = payments.filter((p) => !p.excluded);
  for (let i = 0; i < kept.length - 1; i += 1) {
    const diff = kept[i]!.amountMinor - kept[i + 1]!.amountMinor;
    if (diff !== 0) kept[i]!.changeMinor = diff;
  }
  return {
    subscriptionId: id,
    match,
    matchSource,
    payments,
    totalMinor: kept.reduce((n, p) => n + p.amountMinor, 0),
  };
}

/** Marks a matching transaction as not (or again as) a payment of the subscription. */
export function setPaymentExcluded(
  db: AppDb,
  subscriptionId: number,
  transactionId: number,
  excluded: boolean,
): void {
  requireSubscription(db, subscriptionId);
  if (excluded) {
    db.insert(subscriptionPaymentExclusions)
      .values({ subscriptionId, transactionId })
      .onConflictDoNothing()
      .run();
  } else {
    db.delete(subscriptionPaymentExclusions)
      .where(
        and(
          eq(subscriptionPaymentExclusions.subscriptionId, subscriptionId),
          eq(subscriptionPaymentExclusions.transactionId, transactionId),
        ),
      )
      .run();
  }
}

export type RenewalKind = "trial" | "renewal" | "ending" | "price" | "yearly_charge";

export interface RenewalItem {
  /** Names the item and its date, so dismissing it does not hide the next one. */
  key: string;
  kind: RenewalKind;
  title: string;
  detail: string;
  date: string;
  amountMinor: number | null;
  /** For a price change: how much more than before. */
  changeMinor?: number;
  /** The tracked subscription, when it is one. */
  subscriptionId: number | null;
}

/** How far ahead each kind is shown. */
const AHEAD_DAYS: Record<RenewalKind, number> = {
  trial: 14,
  renewal: 30,
  ending: 45,
  price: 0,
  yearly_charge: 30,
};
/** A price change is shown for this long after the charge. */
const PRICE_DAYS = 60;

/** What is coming up, soonest first, without the items the user dismissed. */
export function renewalInbox(
  db: AppDb,
  today = new Date().toISOString().slice(0, 10),
): RenewalItem[] {
  const items: RenewalItem[] = [];
  const within = (date: string | null, kind: RenewalKind): date is string =>
    date !== null && date >= today && date <= addDays(today, AHEAD_DAYS[kind]);
  const tracked = listTrackedSubscriptions(db, today).subscriptions;

  for (const s of tracked) {
    if (s.status !== "active" || s.ended) continue;
    if (within(s.trialEndsOn, "trial")) {
      items.push({
        key: `trial:${s.id}:${s.trialEndsOn}`,
        kind: "trial",
        title: `${s.name} trial ends`,
        detail: "Cancel before then if you do not want to pay for it.",
        date: s.trialEndsOn,
        amountMinor: s.amountMinor,
        subscriptionId: s.id,
      });
    }
    const yearly =
      s.billing === "recurring" &&
      ((s.frequency === "yearly" && s.repeatEvery >= 1) ||
        (s.frequency === "monthly" && s.repeatEvery >= 12));
    if (yearly && within(s.nextCharge, "renewal") && s.amountMinor > 0) {
      items.push({
        key: `renewal:${s.id}:${s.nextCharge}`,
        kind: "renewal",
        title: `${s.name} renews`,
        detail: "A yearly charge: a good moment to decide whether to keep it.",
        date: s.nextCharge,
        amountMinor: s.amountMinor,
        subscriptionId: s.id,
      });
    }
    // A plan's last payment, or the day prepaid time runs out.
    const endsOn =
      s.billing === "installments" && s.termMonths !== null
        ? addMonthsToDay(s.startDate, s.termMonths - 1)
        : s.endDate;
    if (s.billing !== "recurring" && within(endsOn, "ending")) {
      items.push({
        key: `ending:${s.id}:${endsOn}`,
        kind: "ending",
        title: `${s.name} ends`,
        detail:
          s.billing === "installments"
            ? "The last payment of the plan. Check whether it renews on its own."
            : "The prepaid time runs out. Check whether it renews on its own.",
        date: endsOn,
        amountMinor: s.billing === "installments" ? s.amountMinor : null,
        subscriptionId: s.id,
      });
    }
    // The latest payment costs more than the one before it.
    const latest = paymentHistory(db, s.id, today).payments.find((p) => !p.excluded);
    if (
      latest &&
      latest.changeMinor !== null &&
      latest.changeMinor > 0 &&
      latest.date >= addDays(today, -PRICE_DAYS)
    ) {
      items.push({
        key: `price:${s.id}:${latest.date}`,
        kind: "price",
        title: `${s.name} costs more`,
        detail: "The latest payment was more than the one before it.",
        date: latest.date,
        amountMinor: latest.amountMinor,
        changeMinor: latest.changeMinor,
        subscriptionId: s.id,
      });
    }
  }

  // Yearly charges found in the history but not tracked, such as a card's annual fee.
  const trackedKeys = new Set(tracked.map((s) => s.recurringKey).filter(Boolean));
  for (const series of recurringReport(db, { today }).series) {
    if (
      series.cadence !== "yearly" ||
      series.direction !== "out" ||
      series.status !== "active" ||
      series.dismissed ||
      trackedKeys.has(series.key) ||
      !within(series.nextExpected, "yearly_charge")
    ) {
      continue;
    }
    items.push({
      key: `yearly:${series.key}:${series.nextExpected}`,
      kind: "yearly_charge",
      title: `${series.merchant} yearly charge`,
      detail: "Charged once a year, such as an annual fee or membership.",
      date: series.nextExpected,
      amountMinor: series.typicalAmountMinor,
      subscriptionId: null,
    });
  }

  const dismissed = new Set(
    db
      .select({ key: renewalDismissals.key })
      .from(renewalDismissals)
      .all()
      .map((r) => r.key),
  );
  return items.filter((i) => !dismissed.has(i.key)).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function dismissRenewal(db: AppDb, key: string, now = new Date().toISOString()): void {
  if (!key.trim()) throw new AppError(400, "invalid_key", "Which item?");
  db.insert(renewalDismissals).values({ key, dismissedAt: now }).onConflictDoNothing().run();
}
