import { and, eq } from "drizzle-orm";
import { plaidItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { budgetMonth } from "./budget.service.js";
import { cashForecast } from "./forecast.service.js";
import { getSettings } from "./settings.service.js";
import { minorUnitDigits } from "../utils/money.js";

/**
 * Reminders for the desktop notifications the user turned on in Settings: payments due in the next
 * few days, banks that need a fresh sign-in, and budgets nearly or fully used. Each has an `id` that
 * stays the same for the same occasion, so the app shows it once (a bill once per due date, a
 * budget once per month and level, a sign-in once a day).
 */
export interface Reminder {
  id: string;
  kind: "bill" | "sign_in" | "budget";
  title: string;
  body: string;
}

/** How many days ahead a payment counts as due soon (today plus this many). */
export const BILL_DAYS_AHEAD = 3;
/** A budget this much used, in whole percent, is nearly used up. */
export const BUDGET_NEAR_PERCENT = 90;

function when(date: string, today: string): string {
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `on ${weekday}`;
}

/** $1,234.56: amounts in a notification's words. */
function formatMinorPlain(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minor / 10 ** minorUnitDigits(currency),
  );
}

export function dueReminders(db: AppDb, today = new Date().toISOString().slice(0, 10)): Reminder[] {
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const settings = getSettings(db);
  const wanted = settings.reminders;
  const out: Reminder[] = [];

  if (wanted.bills) {
    const last = addDays(today, BILL_DAYS_AHEAD);
    for (const day of cashForecast(db, { today }).days) {
      if (day.date < today || day.date > last) continue;
      for (const e of day.events) {
        // Payments the user makes: card bills, recurring charges and expected ones. Not pending
        // charges (already spent) or the debt plan's extra (a plan, not a bill).
        if (e.amountMinor >= 0) continue;
        if (e.source !== "card_bill" && e.source !== "recurring" && e.source !== "expected")
          continue;
        out.push({
          id: `bill:${day.date}:${e.source}:${e.accountId ?? e.seriesKey ?? e.label}`,
          kind: "bill",
          title: `${e.label} is due ${when(day.date, today)}`,
          body: `${formatMinorPlain(-e.amountMinor, settings.currency)} ${e.source === "card_bill" ? "card payment" : "payment"}.`,
        });
      }
    }
  }

  if (wanted.signIn) {
    const broken = db
      .select({ id: plaidItems.id, name: plaidItems.institutionName })
      .from(plaidItems)
      .where(
        and(
          eq(plaidItems.status, "login_required"),
          eq(plaidItems.environment, settings.plaidEnvironment),
        ),
      )
      .all();
    for (const item of broken) {
      out.push({
        id: `sign_in:${item.id}:${today}`,
        kind: "sign_in",
        title: `${item.name} needs you to sign in again`,
        body: "Its balances and transactions stopped updating. Open Accounts and use Reconnect; nothing is lost.",
      });
    }
  }

  if (wanted.budgets) {
    const month = today.slice(0, 7);
    for (const b of budgetMonth(db, month, settings.plaidEnvironment).budgets) {
      if (b.availableMinor <= 0 || b.percentUsed < BUDGET_NEAR_PERCENT) continue;
      const over = b.percentUsed >= 100;
      out.push({
        id: `budget:${month}:${b.categoryId}:${over ? "over" : "near"}`,
        kind: "budget",
        title: `${b.categoryName} budget is ${over ? (b.percentUsed > 100 ? "over" : "used up") : "nearly used up"}`,
        body: `${formatMinorPlain(b.spentMinor, settings.currency)} of ${formatMinorPlain(b.availableMinor, settings.currency)} spent this month (${b.percentUsed}%).`,
      });
    }
  }
  return out;
}
