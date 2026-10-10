import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { IS_INCOME, NOT_TRANSFER } from "./analytics.service.js";
import { deleteSetting } from "./settings.service.js";
import { appSettings } from "../../../drizzle/schema.js";
import { eq } from "drizzle-orm";

/**
 * The Taxes page: the year's income and credit transactions (by the same rule the charts use for
 * income), grouped by where they came from, plus the answers the user gives about each source.
 */

export interface TaxIncomeTransaction {
  id: number;
  date: string;
  merchant: string;
  amountMinor: number; // money in, as a positive number
  accountName: string;
  categoryName: string | null;
  /** "credit" when its category counts money in as taxable income (Transfers > Credit). */
  kind: "income" | "credit";
  source: string;
  pending: boolean;
  /** Looks like a paycheck (the bank says wages, or the name reads like payroll). */
  wages: boolean;
}

export interface TaxIncomeSource {
  key: string;
  label: string;
  kind: "income" | "credit";
  totalMinor: number;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Any of its money looks like a paycheck, so FICA likely applies. */
  wages: boolean;
}

export interface TaxIncome {
  year: number;
  transactions: TaxIncomeTransaction[];
  sources: TaxIncomeSource[];
}

interface Row {
  id: number;
  date: string;
  merchant: string;
  amount_minor: number;
  account_name: string;
  category_name: string | null;
  treatment: string | null;
  source: string;
  pending: number;
  wages: number;
}

export function taxIncome(db: AppDb, year: number, environment: string): TaxIncome {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = db.all<Row>(sql`
    select t.id, coalesce(t.authorized_date, t.date) as date,
      coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
      -t.amount_minor as amount_minor, a.name as account_name, c.name as category_name,
      c.income_treatment as treatment, t.pending,
      (coalesce(t.plaid_category_detailed, '') = 'INCOME_WAGES'
        or lower(t.name) like '%payroll%' or lower(t.name) like '%direct dep%'
        or lower(t.name) like '%salary%') as wages,
      coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), ''),
        nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as source
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
      left join categories c on c.id = t.category_id
    where coalesce(t.authorized_date, t.date) between ${from} and ${to}
      and (p.environment = ${environment} or a.plaid_item_id is null)
      and a.hidden = 0 and t.amount_minor < 0
      and ${NOT_TRANSFER} and ${IS_INCOME}
    order by date desc, t.id desc
  `);
  const transactions: TaxIncomeTransaction[] = rows.map((r) => ({
    id: r.id,
    date: r.date,
    merchant: r.merchant,
    amountMinor: r.amount_minor,
    accountName: r.account_name,
    categoryName: r.category_name,
    kind: r.treatment === "income" ? "credit" : "income",
    source: r.source,
    pending: r.pending === 1,
    wages: r.wages === 1,
  }));
  // Credits are grouped together; other income by who paid it.
  const bySource = new Map<string, TaxIncomeSource>();
  for (const t of transactions) {
    const key = t.kind === "credit" ? "credit" : `income:${t.source.trim().toLowerCase()}`;
    const s = bySource.get(key) ?? {
      key,
      label: t.kind === "credit" ? "Credits" : t.source,
      kind: t.kind,
      totalMinor: 0,
      count: 0,
      firstDate: t.date,
      lastDate: t.date,
      wages: false,
    };
    s.totalMinor += t.amountMinor;
    s.count += 1;
    if (t.wages) s.wages = true;
    if (t.date < s.firstDate) s.firstDate = t.date;
    if (t.date > s.lastDate) s.lastDate = t.date;
    bySource.set(key, s);
  }
  const sources = [...bySource.values()].sort((a, b) => b.totalMinor - a.totalMinor);
  return { year, transactions, sources };
}

// ---- The user's answers, kept per year ------------------------------------------------------

const money = z.number().min(0).max(100_000_000);

export const taxSourceSchema = z
  .object({
    key: z.string().min(1).max(300),
    label: z.string().max(200),
    /** What it pays in a full year, in dollars (null: use what the transactions suggest). */
    annualIncome: money.nullable(),
    /** No Social Security or Medicare on it (credits, some government or student jobs). */
    ficaExempt: z.boolean(),
    /** 401(k), TSP, 403(b): lower income tax, not FICA. */
    pretaxRetirement: money,
    /** Health, dental, vision, HSA, FSA through payroll: lower income tax and FICA. */
    pretaxBenefits: money,
    /** Leave this source out of the estimate. */
    excluded: z.boolean().default(false),
  })
  .strict();

export const taxProfileSchema = z
  .object({
    filingStatus: z.enum(["single", "married_joint", "head_of_household"]),
    state: z.enum(["MD", "DC", "VA", "none"]),
    /** A Maryland county (or Baltimore City) for county income tax. */
    marylandCounty: z.string().max(60).nullable(),
    /** Any other local income tax, as a flat percent. */
    customLocalRate: z.number().min(0).max(20).nullable(),
    customLocalName: z.string().max(80).nullable(),
    /** Withheld so far / paid, to show what is left to pay or come back (dollars). */
    federalWithheld: money.nullable(),
    stateWithheld: money.nullable(),
    sources: z.array(taxSourceSchema).max(100),
  })
  .strict();

export type TaxProfile = z.infer<typeof taxProfileSchema>;

const keyFor = (year: number): string => `tax_profile_${year}`;

export function getTaxProfile(db: AppDb, year: number): TaxProfile | null {
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, keyFor(year)))
    .get();
  if (!row) return null;
  try {
    const parsed = taxProfileSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveTaxProfile(db: AppDb, year: number, profile: TaxProfile): TaxProfile {
  const now = new Date().toISOString();
  const value = JSON.stringify(profile);
  db.insert(appSettings)
    .values({ key: keyFor(year), value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
  return profile;
}

export function clearTaxProfile(db: AppDb, year: number): void {
  deleteSetting(db, keyFor(year));
}
