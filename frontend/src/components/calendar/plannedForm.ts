import { parseMoneyToMinor } from "../../lib/money";
import type { PlannedItem } from "../../types/calendar";
import { weekdayOf } from "./range";

/** What the "expected transaction" form keeps while it is open: everything is text until saved. */
export interface PlannedDraft {
  merchant: string;
  amount: string;
  direction: "out" | "in";
  accountId: string;
  categoryId: string;
  person: string;
  notes: string;
  startDate: string;
  frequency: "once" | "daily" | "weekly" | "monthly" | "yearly";
  repeatEvery: string;
  /** Weekly: the days of the week to repeat on (0 = Sunday). */
  weekdays: number[];
  monthMode: "day" | "weekday";
  /** Monthly by day: "" (the start date's day), "1" to "31", or "-1" for the last day. */
  dayOfMonth: string;
  /** Monthly by weekday: "" (as the start date falls), "1" to "4", or "-1" for the last. */
  nthWeek: string;
  /** Monthly by weekday: "" (the start date's weekday) or "0" to "6". */
  monthWeekday: string;
  endMode: "never" | "on" | "after";
  endDate: string;
  maxCount: string;
}

export function emptyPlannedDraft(date: string, accountId = ""): PlannedDraft {
  return {
    merchant: "",
    amount: "",
    direction: "out",
    accountId,
    categoryId: "",
    person: "",
    notes: "",
    startDate: date,
    frequency: "once",
    repeatEvery: "1",
    weekdays: [weekdayOf(date)],
    monthMode: "day",
    dayOfMonth: "",
    nthWeek: "",
    monthWeekday: "",
    endMode: "never",
    endDate: "",
    maxCount: "",
  };
}

/** The form's starting point for editing an expected transaction that already exists. */
export function draftFromPlanned(p: PlannedItem): PlannedDraft {
  return {
    merchant: p.merchant,
    amount: (p.amountMinor / 100).toFixed(2),
    direction: p.direction,
    accountId: p.accountId === null ? "" : String(p.accountId),
    categoryId: p.categoryId === null ? "" : String(p.categoryId),
    person: p.person ?? "",
    notes: p.notes ?? "",
    startDate: p.startDate,
    frequency: p.frequency,
    repeatEvery: String(p.repeatEvery),
    weekdays: p.frequency === "weekly" ? p.weekdays : [weekdayOf(p.startDate)],
    monthMode: p.monthMode ?? "day",
    dayOfMonth: p.dayOfMonth === null ? "" : String(p.dayOfMonth),
    nthWeek: p.nthWeek === null ? "" : String(p.nthWeek),
    monthWeekday:
      p.frequency === "monthly" && p.monthMode === "weekday" && p.weekdays[0] !== undefined
        ? String(p.weekdays[0])
        : "",
    endMode: p.endDate ? "on" : p.maxCount !== null ? "after" : "never",
    endDate: p.endDate ?? "",
    maxCount: p.maxCount === null ? "" : String(p.maxCount),
  };
}

export type RuleResult =
  { ok: true; rule: Record<string, unknown> } | { ok: false; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The repeat part of the form as the server wants it, or a message about what to fix. */
export function buildRule(draft: PlannedDraft): RuleResult {
  if (!DATE.test(draft.startDate)) {
    return { ok: false, message: "Choose the date of the first occurrence." };
  }
  const rule: Record<string, unknown> = {
    startDate: draft.startDate,
    frequency: draft.frequency,
  };
  if (draft.frequency === "once") return { ok: true, rule };

  const every = Number(draft.repeatEvery);
  if (!Number.isInteger(every) || every < 1 || every > 365) {
    return { ok: false, message: "Repeat every must be a whole number from 1 to 365." };
  }
  rule["repeatEvery"] = every;

  if (draft.frequency === "weekly") {
    if (draft.weekdays.length === 0) {
      return { ok: false, message: "Choose at least one day of the week." };
    }
    rule["weekdays"] = [...draft.weekdays].sort((a, b) => a - b);
  }
  if (draft.frequency === "monthly") {
    rule["monthMode"] = draft.monthMode;
    const startDay = Number(draft.startDate.slice(8));
    if (draft.monthMode === "day") {
      rule["dayOfMonth"] = draft.dayOfMonth === "" ? startDay : Number(draft.dayOfMonth);
    } else {
      rule["nthWeek"] =
        draft.nthWeek === "" ? Math.min(4, Math.ceil(startDay / 7)) : Number(draft.nthWeek);
      rule["weekdays"] = [
        draft.monthWeekday === "" ? weekdayOf(draft.startDate) : Number(draft.monthWeekday),
      ];
    }
  }

  if (draft.endMode === "on") {
    if (!DATE.test(draft.endDate)) {
      return { ok: false, message: "Choose the date it stops repeating." };
    }
    if (draft.endDate < draft.startDate) {
      return { ok: false, message: "It cannot stop before it starts." };
    }
    rule["endDate"] = draft.endDate;
  } else if (draft.endMode === "after") {
    const count = Number(draft.maxCount);
    if (!Number.isInteger(count) || count < 1) {
      return { ok: false, message: "Enter how many times it happens (1 or more)." };
    }
    rule["maxCount"] = count;
  }
  return { ok: true, rule };
}

export type PlannedResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

/** Checks the whole form and builds what the server expects. */
export function buildPlannedPayload(draft: PlannedDraft): PlannedResult {
  const merchant = draft.merchant.trim();
  if (merchant === "") return { ok: false, message: "Enter who the payment is with." };
  const amountMinor = parseMoneyToMinor(draft.amount, "USD");
  if (amountMinor === null) {
    return {
      ok: false,
      message: "Enter the amount as a positive number such as 12.50. Choose money in or out below.",
    };
  }
  const rule = buildRule(draft);
  if (!rule.ok) return rule;
  return {
    ok: true,
    payload: {
      merchant,
      amountMinor,
      direction: draft.direction,
      accountId: draft.accountId === "" ? null : Number(draft.accountId),
      categoryId: draft.categoryId === "" ? null : Number(draft.categoryId),
      person: draft.person.trim() === "" ? null : draft.person.trim(),
      notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
      ...rule.rule,
    },
  };
}
