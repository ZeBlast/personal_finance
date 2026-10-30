/** How subscriptions are described in words on the Subscriptions page. Pure. */
import { formatDay } from "../../lib/time";
import type { RenewalItem, SubscriptionBilling, SubscriptionFrequency } from "../../types/planning";
import { money } from "./shared";

// ---- Your subscriptions --------------------------------------------------------------------------

/** How it is billed, in words: "$15.49 every month", "$40 a month for 12 months". */
export function billingText(s: {
  amountMinor: number;
  billing: SubscriptionBilling;
  frequency: SubscriptionFrequency | null;
  repeatEvery: number;
  termMonths: number | null;
}): string {
  if (s.amountMinor === 0) {
    return s.billing === "recurring" ? "Free" : `Free, for ${s.termMonths} months`;
  }
  const amount = money(s.amountMinor);
  if (s.billing === "installments") return `${amount} a month for ${s.termMonths} months`;
  if (s.billing === "prepaid") return `${amount} once, for ${s.termMonths} months`;
  const unit = s.frequency === "weekly" ? "week" : s.frequency === "yearly" ? "year" : "month";
  return s.repeatEvery > 1
    ? `${amount} every ${s.repeatEvery} ${unit}s`
    : `${amount} every ${unit}`;
}

// ---- Coming up -----------------------------------------------------------------------------------

/** What an inbox item says next to its title: when, and how much. Pure. */
export function renewalWhen(item: RenewalItem, today: string): string {
  const days = Math.round((Date.parse(item.date) - Date.parse(today)) / 86_400_000);
  const when =
    item.kind === "price"
      ? `charged ${formatDay(item.date)}`
      : days === 0
        ? "today"
        : days === 1
          ? "tomorrow"
          : `in ${days} days, ${formatDay(item.date)}`;
  if (item.kind === "price" && item.changeMinor) {
    return `${when} · now ${money(item.amountMinor ?? 0)}, up ${money(item.changeMinor)}`;
  }
  return item.amountMinor ? `${when} · ${money(item.amountMinor)}` : when;
}
