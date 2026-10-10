/** Cashback rules and what a card has earned (see backend/src/services/cashback.service.ts). */

export interface CashbackRule {
  /** For a category rate, its category (null is "everything else"); for an exclusion, what it is from. */
  categoryId: number | null;
  categoryName: string | null;
  /** For a merchant rate or an exclusion: text the merchant's name contains. */
  merchant: string | null;
  exclude: boolean;
  ratePercent: number;
  /** A rate that applies only to purchases made online. */
  onlineOnly: boolean;
}

export interface CashbackBucket {
  categoryId: number | null;
  merchant: string | null;
  online: boolean;
  label: string;
  rateBps: number | null;
  spendMinor: number;
  cashbackMinor: number;
}

export interface CardCashback {
  accountId: number;
  name: string;
  color: string | null;
  institutionName: string | null;
  cashbackMinor: number;
  spendMinor: number;
  hasRates: boolean;
  buckets: CashbackBucket[];
}

export interface CashbackSummary {
  from: string;
  to: string;
  currency: string;
  totalCashbackMinor: number;
  cards: CardCashback[];
}

/** Whether a purchase was paid with the best card for it (see `transactionCashback` on the server). */
export interface TransactionCashback {
  status: "best" | "card" | "missed";
  cashbackMinor: number;
  rateBps: number;
  bestRateBps: number;
  bestCard: string | null;
  online: boolean;
}

export type RuleKind = "category" | "merchant" | "exclude";

export const RULE_KINDS: Array<{ value: RuleKind; label: string }> = [
  { value: "category", label: "Category rate" },
  { value: "merchant", label: "Merchant rate" },
  { value: "exclude", label: "Exclude a merchant" },
];

/** One row of the rules editor: everything is text until saved. */
export interface RateDraft {
  kind: RuleKind;
  /** "" is "everything else" (or, for an exclusion, every rate). */
  categoryId: string;
  merchant: string;
  rate: string;
  onlineOnly: boolean;
}

export const emptyDraft = (): RateDraft => ({
  kind: "category",
  categoryId: "",
  merchant: "",
  rate: "",
  onlineOnly: false,
});

export function draftsFromRules(rules: CashbackRule[]): RateDraft[] {
  return rules.map((r) => ({
    kind: r.exclude ? "exclude" : r.merchant !== null ? "merchant" : "category",
    categoryId: r.categoryId === null ? "" : String(r.categoryId),
    merchant: r.merchant ?? "",
    rate: r.exclude ? "" : String(r.ratePercent),
    onlineOnly: r.onlineOnly,
  }));
}

/** A row the user has not filled in at all. */
export function isBlankDraft(d: RateDraft): boolean {
  return d.kind === "category" && d.categoryId === "" && d.rate.trim() === "";
}

/** Reads "5", "1.5", "2.25%" as a percentage with at most two decimals, or null. */
export function parseRatePercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value >= 0 && value <= 100 ? value : null;
}

export interface RulePayload {
  categoryId: number | null;
  ratePercent: number;
  onlineOnly: boolean;
  merchant: string | null;
  exclude: boolean;
}

export type RatesResult = { ok: true; rules: RulePayload[] } | { ok: false; message: string };

/** Checks the editor and builds what the server expects. */
export function buildRulesPayload(rows: RateDraft[]): RatesResult {
  const seen = new Set<string>();
  const rules: RulePayload[] = [];
  for (const row of rows) {
    const merchant = row.merchant.trim();
    if (row.kind !== "category" && merchant === "") {
      return { ok: false, message: "Enter the merchant's name (or part of it), such as Walmart." };
    }
    const percent = row.kind === "exclude" ? 0 : parseRatePercent(row.rate);
    if (percent === null) {
      return {
        ok: false,
        message:
          "Enter each rate as a percentage from 0 to 100 with at most two decimals, such as 1.5.",
      };
    }
    const online = row.kind !== "exclude" && row.onlineOnly;
    const category = row.kind === "merchant" ? "" : row.categoryId;
    const key = `${row.kind}:${category}:${merchant.toLowerCase()}:${online}`;
    if (seen.has(key)) {
      const onlineText = online ? " for online purchases" : "";
      return {
        ok: false,
        message:
          row.kind === "exclude"
            ? `“${merchant}” is excluded twice.`
            : row.kind === "merchant"
              ? `“${merchant}” has two rates${onlineText}.`
              : row.categoryId === ""
                ? `There can be only one rate for everything else${onlineText}.`
                : `Each category can have only one rate${onlineText}.`,
      };
    }
    seen.add(key);
    rules.push({
      categoryId: category === "" ? null : Number(category),
      ratePercent: percent,
      onlineOnly: online,
      merchant: row.kind === "category" ? null : merchant,
      exclude: row.kind === "exclude",
    });
  }
  return { ok: true, rules };
}

/** A rate in basis points as a percentage: 150 becomes "1.5%". */
export function formatRate(bps: number | null): string {
  if (bps === null) return "no rate";
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** How a purchase's card choice is shown in the transaction list. */
export function cashbackBadge(c: TransactionCashback): {
  tone: "green" | "yellow" | "red";
  text: string;
  title: string;
} {
  const best =
    c.bestCard && c.bestRateBps > 0
      ? `${c.bestCard} would earn ${formatRate(c.bestRateBps)}.`
      : "No card earns cashback on this.";
  if (c.status === "best") {
    return {
      tone: "green",
      text: "+cashback",
      title: `The best card for this: ${formatRate(c.rateBps)}${c.online ? " (online rate)" : ""}.`,
    };
  }
  if (c.status === "card") {
    return {
      tone: "yellow",
      text: "+cashback",
      title: `Paid with a credit card at ${formatRate(c.rateBps)}. ${best}`,
    };
  }
  return { tone: "red", text: "no cashback", title: `Not paid with a credit card. ${best}` };
}
