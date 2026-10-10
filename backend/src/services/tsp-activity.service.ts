import { investmentTransactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { setFundPrice } from "./fund-price.service.js";
import { findKnownFund } from "./investment-funds.js";
import { upsertManualSecurity } from "./investment.service.js";
import { heldFunds, isTspAccount, writeHoldings } from "./tsp.service.js";

/**
 * The "Investment Activity Detail" file the TSP lets you download: one row per contribution (your
 * own, the agency's automatic and matching ones, and so on) with the fund, the dollar amount, the
 * unit price that day, and the units bought. Importing it records the real history, and the unit
 * prices in it are kept as fund prices.
 */

export interface ActivityRow {
  date: string;
  postingDate: string;
  activity: string;
  symbol: string;
  amountMinor: number;
  price: number;
  units: number;
}

export interface ParsedActivity {
  rows: ActivityRow[];
  /** Rows skipped because they are for a fund this app does not know. */
  skipped: number;
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/** Reads 09-04-2024 or 9/4/2024 as 2024-09-04. */
export function parseActivityDate(text: string): string | null {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text.trim());
  if (!m) return null;
  const day = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return isRealDate(day) ? day : null;
}

function cells(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

const number = (text: string | undefined): number | null => {
  const n = Number((text ?? "").replace(/[$,\s]/g, ""));
  return (text ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

export function parseActivityCsv(text: string): ParsedActivity {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const headerIndex = lines.findIndex((l) => /valuation date/i.test(l));
  if (headerIndex < 0) {
    throw new AppError(
      400,
      "invalid_activity_file",
      'That does not look like the TSP\'s Investment Activity Detail file: it needs a header row with "VALUATION DATE", "ACTIVITY TYPE", "FUND", "AMOUNT", "FUND NAV/PRICE" and "FUND UNITS".',
    );
  }
  const header = cells(lines[headerIndex]!).map((h) => h.toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const idx = {
    date: col("valuation date"),
    posting: col("posting date"),
    activity: col("activity type"),
    fund: col("fund"),
    amount: col("amount"),
    price: col("fund nav/price"),
    units: col("fund units"),
  };
  const missing = Object.entries(idx)
    .filter(([key, i]) => i < 0 && key !== "posting")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new AppError(
      400,
      "invalid_activity_file",
      `The activity file is missing a column for: ${missing.join(", ")}.`,
    );
  }
  const rows: ActivityRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    const c = cells(line);
    const date = parseActivityDate(c[idx.date] ?? "");
    if (date === null) continue; // notes and blank lines
    const fund = findKnownFund(c[idx.fund]);
    const amount = number(c[idx.amount]);
    const price = number(c[idx.price]);
    const units = number(c[idx.units]);
    if (!fund) {
      skipped += 1;
      continue;
    }
    if (amount === null || price === null || units === null || price <= 0) continue;
    rows.push({
      date,
      postingDate: parseActivityDate(c[idx.posting] ?? "") ?? date,
      activity: (c[idx.activity] ?? "").trim() || "Contribution",
      symbol: fund.symbol,
      amountMinor: Math.round(amount * 100),
      price,
      units,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.activity.localeCompare(b.activity));
  return { rows, skipped };
}

export interface ActivityImportSummary {
  rows: number;
  added: number;
  alreadyThere: number;
  skipped: number;
  from: string | null;
  to: string | null;
  holdingsUpdated: boolean;
  pricesSaved: number;
}

/**
 * Records the file's activity on a TSP account. A row that was imported before is skipped, so the same
 * file can be imported again safely. With `updateHoldings`, the units of rows that are new are added
 * to what the account holds; leave it off when the holdings already include this history.
 */
export function importActivityCsv(
  db: AppDb,
  accountId: number,
  csv: string,
  options: { updateHoldings: boolean; now: string; today?: string },
): ActivityImportSummary {
  if (!isTspAccount(db, accountId)) throw notFound("TSP account");
  const parsed = parseActivityCsv(csv);
  if (parsed.rows.length === 0) {
    throw new AppError(400, "invalid_activity_file", "There are no activity rows in that file.");
  }
  const { now } = options;
  const today = options.today ?? now.slice(0, 10);
  const gained = new Map<string, { units: number; amountMinor: number }>();
  let added = 0;
  let pricesSaved = 0;

  db.transaction((tx) => {
    for (const r of parsed.rows) {
      setFundPrice(tx, r.symbol, r.date, r.price, "csv", now);
      pricesSaved += 1;
      // The fund is created if this account has never held it, so the row is tied to it.
      const securityId = upsertManualSecurity(tx, { symbol: r.symbol, currency: "USD" }, now);
      const fund = findKnownFund(r.symbol)!;
      const incoming = r.units >= 0;
      const inserted = tx
        .insert(investmentTransactions)
        .values({
          accountId,
          securityId,
          importKey: `tspact:${accountId}:${r.date}:${r.activity}:${r.symbol}:${r.amountMinor}:${r.units}`,
          date: r.date,
          type: incoming ? "contribution" : "withdrawal",
          name: `${r.activity} (${fund.name})`,
          quantity: Math.abs(r.units),
          price: r.price,
          amountMinor: -r.amountMinor, // money coming in is stored negative
          feesMinor: null,
          currency: "USD",
          subtype: r.activity.toLowerCase(),
          source: "manual",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: investmentTransactions.importKey })
        .run();
      if (inserted.changes === 0) continue;
      added += 1;
      const g = gained.get(r.symbol) ?? { units: 0, amountMinor: 0 };
      g.units += r.units;
      g.amountMinor += r.amountMinor;
      gained.set(r.symbol, g);
    }
  });

  if (options.updateHoldings && gained.size > 0) {
    const funds = new Map<string, Parameters<typeof writeHoldings>[2][number]>();
    for (const h of heldFunds(db, accountId)) {
      funds.set(h.symbol, {
        symbol: h.symbol,
        name: h.name,
        assetClass: h.assetClass,
        quantity: h.quantity,
        costBasisMinor: h.costBasisMinor,
        fallbackPrice: h.price,
        fallbackValueMinor: h.valueMinor,
      });
    }
    for (const [symbol, g] of gained) {
      const fund = findKnownFund(symbol)!;
      const before = funds.get(symbol);
      funds.set(symbol, {
        symbol,
        name: fund.name,
        assetClass: fund.assetClass,
        quantity: round6(Math.max(0, (before?.quantity ?? 0) + g.units)),
        costBasisMinor: (before?.costBasisMinor ?? 0) + g.amountMinor,
        fallbackPrice: before?.fallbackPrice ?? null,
        fallbackValueMinor: before?.fallbackValueMinor ?? 0,
      });
    }
    writeHoldings(db, accountId, [...funds.values()], today, now);
  }

  return {
    rows: parsed.rows.length,
    added,
    alreadyThere: parsed.rows.length - added,
    skipped: parsed.skipped,
    from: parsed.rows[0]!.date,
    to: parsed.rows.at(-1)!.date,
    holdingsUpdated: options.updateHoldings && gained.size > 0,
    pricesSaved,
  };
}
