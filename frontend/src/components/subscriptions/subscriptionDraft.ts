/** The add/edit subscription form's draft, and turning it into what the API saves. Pure. */
import { parseMoneyToMinor } from "../../lib/money";
import type { Cadence } from "../../types/insights";
import type {
  Subscription,
  SubscriptionBilling,
  SubscriptionFrequency,
  TrackedSubscription,
} from "../../types/planning";
import { todayDay } from "./shared";

// ---- The add / edit dialog -----------------------------------------------------------------------

export interface Draft {
  id: number | null;
  name: string;
  amount: string;
  billing: SubscriptionBilling;
  frequency: SubscriptionFrequency;
  repeatEvery: string;
  startDate: string;
  termMonths: string;
  accountId: string;
  categoryId: string;
  email: string;
  username: string;
  website: string;
  notes: string;
  recurringKey: string | null;
  trialEndsOn: string;
  paymentMatch: string;
}

export function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    amount: "",
    billing: "recurring",
    frequency: "monthly",
    repeatEvery: "1",
    startDate: todayDay(),
    termMonths: "12",
    accountId: "",
    categoryId: "",
    email: "",
    username: "",
    website: "",
    notes: "",
    recurringKey: null,
    trialEndsOn: "",
    paymentMatch: "",
  };
}

export function draftOf(s: TrackedSubscription): Draft {
  return {
    id: s.id,
    name: s.name,
    amount: (s.amountMinor / 100).toFixed(2),
    billing: s.billing,
    frequency: s.frequency ?? "monthly",
    repeatEvery: String(s.repeatEvery),
    startDate: s.startDate,
    termMonths: String(s.termMonths ?? 12),
    accountId: s.accountId === null ? "" : String(s.accountId),
    categoryId: s.categoryId === null ? "" : String(s.categoryId),
    email: s.email ?? "",
    username: s.username ?? "",
    website: s.website ?? "",
    notes: s.notes ?? "",
    recurringKey: s.recurringKey,
    trialEndsOn: s.trialEndsOn ?? "",
    paymentMatch: s.paymentMatch ?? "",
  };
}

/** A recurring charge found in the history, as a subscription to track. */
export function draftFromSeries(s: Subscription): Draft {
  const cadence = s.cadence as Cadence;
  const [frequency, every]: [SubscriptionFrequency, number] =
    cadence === "weekly"
      ? ["weekly", 1]
      : cadence === "biweekly"
        ? ["weekly", 2]
        : cadence === "quarterly"
          ? ["monthly", 3]
          : cadence === "yearly"
            ? ["yearly", 1]
            : ["monthly", 1];
  return {
    ...emptyDraft(),
    name: s.merchant,
    amount: (s.typicalAmountMinor / 100).toFixed(2),
    frequency,
    repeatEvery: String(every),
    startDate: s.firstDate,
    recurringKey: s.key,
  };
}

/** The draft as a request, or what is wrong. Pure, so it can be tested. */
export function buildSubscription(
  d: Draft,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!d.name.trim()) return { ok: false, message: "Enter the subscription's name." };
  // Blank or 0 is a free subscription, kept only to keep track of it.
  const amount = d.amount.trim() === "" ? 0 : parseMoneyToMinor(d.amount, "USD");
  if (amount === null || amount < 0) {
    return { ok: false, message: "Enter what each charge costs, such as 15.49 (0 if free)." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.startDate)) {
    return { ok: false, message: "Choose the day it starts." };
  }
  const recurring = d.billing === "recurring";
  const every = Number(d.repeatEvery);
  const term = Number(d.termMonths);
  if (recurring && (!Number.isInteger(every) || every < 1 || every > 36)) {
    return { ok: false, message: "Repeat every 1 to 36 periods." };
  }
  if (!recurring && (!Number.isInteger(term) || term < 1 || term > 120)) {
    return { ok: false, message: "Enter how many months it lasts (1 to 120)." };
  }
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  return {
    ok: true,
    body: {
      name: d.name.trim(),
      amountMinor: amount,
      billing: d.billing,
      frequency: recurring ? d.frequency : null,
      repeatEvery: recurring ? every : 1,
      startDate: d.startDate,
      termMonths: recurring ? null : term,
      accountId: d.accountId ? Number(d.accountId) : null,
      categoryId: d.categoryId ? Number(d.categoryId) : null,
      email: opt(d.email),
      username: opt(d.username),
      website: opt(d.website),
      notes: opt(d.notes),
      recurringKey: d.recurringKey,
      trialEndsOn: opt(d.trialEndsOn),
      paymentMatch: opt(d.paymentMatch),
    },
  };
}
