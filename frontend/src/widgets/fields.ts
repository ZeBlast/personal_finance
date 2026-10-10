import { PERIOD_OPTIONS } from "../lib/period";
import type { ConfigField } from "./types";

/**
 * Settings that many widgets share. Reuse these in a widget's `configFields` instead of rewriting
 * them, so wording and options stay the same everywhere.
 */

export const periodField: ConfigField = {
  key: "period",
  label: "Time period",
  type: "select",
  options: PERIOD_OPTIONS,
};

export const accountField: ConfigField = {
  key: "accountId",
  label: "Account",
  type: "account",
  help: "Leave on “All accounts” to include everything.",
};

/** Picks one investment account, or all of them. */
export const investmentAccountField: ConfigField = {
  key: "accountId",
  label: "Account",
  type: "account",
  accountType: "investment",
  allLabel: "All investment accounts",
};

export const categoryField: ConfigField = {
  key: "categoryId",
  label: "Category",
  type: "category",
};

export const includeTransfersField: ConfigField = {
  key: "includeTransfers",
  label: "Include transfers between my accounts",
  type: "boolean",
  help: "Money moved between your own accounts, and credit-card payments, are left out by default. Payments to or from other people (such as Zelle) always count.",
};

/** A "how many items to show" setting. */
export function countField(key: string, label: string, min: number, max: number): ConfigField {
  return { key, label, type: "number", min, max };
}

/** A "how many months" setting with the usual choices. */
export const monthsField: ConfigField = {
  key: "months",
  label: "Months to show",
  type: "select",
  options: [
    { value: "3", label: "3 months" },
    { value: "6", label: "6 months" },
    { value: "12", label: "12 months" },
  ],
};
