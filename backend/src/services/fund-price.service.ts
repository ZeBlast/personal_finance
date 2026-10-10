import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { fundPrices } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { findKnownFund, TSP_FUNDS } from "./investment-funds.js";

/**
 * Daily fund prices (the value of one unit of a fund on a day), which turn a dollar contribution into
 * units and a number of units into a balance. They come from the price file the TSP publishes (CSV,
 * one column per fund), from an automatic download when the TSP's site allows one, or are typed in.
 */

export interface PriceRow {
  date: string;
  prices: Map<string, number>;
}

export interface ParsedPrices {
  rows: PriceRow[];
  /** Columns that are not a TSP fund (and so were ignored). */
  ignoredColumns: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reads a date written as 2026-10-07, 10/7/2026, "Oct 7, 2026", or "October 7, 2026". */
export function parsePriceDate(text: string): string | null {
  // The chart download writes "2024-06-03 00:00:00"; the time of day means nothing here.
  const t = text
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[ T]00:00(:00)?(\.0+)?$/, "");
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t))) {
    const index = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
    if (index < 0) return null;
    [m, d, y] = [index + 1, Number(match[2]), Number(match[3])];
  } else return null;
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isRealDate(day) ? day : null;
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * Reads a price file in the TSP's layout: a header row with "Date" and one column per fund ("L Income",
 * "L 2050", "G Fund", "C Fund", ...), then one row per day. Blank prices are skipped.
 */
export function parseFundPriceCsv(text: string): ParsedPrices {
  // A byte-order mark (an invisible character some programs put first) is not part of the header.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  // Either a "Date" header, or the chart download's header: a date range such as
  // "May 31, 2024 to Oct 7, 2026" followed by the name of each fund.
  const delimiterOf = (l: string): string =>
    l.includes("\t") ? "\t" : l.includes(";") ? ";" : ",";
  const headerIndex = lines.findIndex((l) => {
    if (/^"?date"?\s*[,\t;]/i.test(l.trim())) return true;
    return splitLine(l, delimiterOf(l))
      .slice(1)
      .some((c) => findKnownFund(c) !== undefined);
  });
  if (headerIndex < 0) {
    throw new AppError(
      400,
      "invalid_price_file",
      'That does not look like a fund price file: it needs a header row that starts with "Date" and has a column for each fund.',
    );
  }
  const delimiter = delimiterOf(lines[headerIndex]!);
  const header = splitLine(lines[headerIndex]!, delimiter);
  const columns: Array<string | null> = header.map((h, i) =>
    i === 0 ? null : (findKnownFund(h)?.symbol ?? null),
  );
  const ignoredColumns = header.filter((h, i) => i > 0 && columns[i] === null && h !== "");
  if (!columns.some((c) => c !== null)) {
    throw new AppError(
      400,
      "invalid_price_file",
      "None of the columns is a TSP fund. Name them such as G Fund, C Fund, or L 2050.",
    );
  }
  const rows: PriceRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitLine(line, delimiter);
    const date = parsePriceDate(cells[0] ?? "");
    if (date === null) continue; // notes, footers, and blank lines
    const prices = new Map<string, number>();
    columns.forEach((symbol, i) => {
      if (!symbol) return;
      const raw = (cells[i] ?? "").replace(/[$,\s]/g, "");
      if (raw === "") return;
      const price = Number(raw);
      if (Number.isFinite(price) && price > 0) prices.set(symbol, price);
    });
    if (prices.size > 0) rows.push({ date, prices });
  }
  return { rows, ignoredColumns };
}

export interface StoredPrice {
  symbol: string;
  date: string;
  price: number;
}

/** Stores one price. A price the user typed is never replaced by an imported or downloaded one. */
export function setFundPrice(
  db: Pick<AppDb, "insert">,
  symbol: string,
  date: string,
  price: number,
  source: "csv" | "fetched" | "manual",
  now: string,
): void {
  db.insert(fundPrices)
    .values({ symbol, date, price, source, createdAt: now })
    .onConflictDoUpdate({
      target: [fundPrices.symbol, fundPrices.date],
      set: { price, source },
      setWhere: sql`${fundPrices.source} <> 'manual' or ${source === "manual" ? 1 : 0} = 1`,
    })
    .run();
}

/** Validates a price typed in by hand. */
export function addManualPrice(
  db: AppDb,
  input: { symbol: string; date: string; price: number },
  now: string,
): StoredPrice {
  const fund = findKnownFund(input.symbol);
  if (!fund) throw new AppError(400, "unknown_fund", "That is not one of the TSP funds.");
  if (!isRealDate(input.date)) {
    throw new AppError(400, "invalid_date", "Enter the date as YYYY-MM-DD.");
  }
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price > 100_000) {
    throw new AppError(400, "invalid_price", "Enter the price of one unit as a positive number.");
  }
  setFundPrice(db, fund.symbol, input.date, input.price, "manual", now);
  return { symbol: fund.symbol, date: input.date, price: input.price };
}

export interface ImportSummary {
  days: number;
  prices: number;
  funds: string[];
  from: string | null;
  to: string | null;
  ignoredColumns: string[];
}

/** Stores every price in a parsed file. Safe to import the same file again. */
export function importFundPrices(
  db: AppDb,
  parsed: ParsedPrices,
  source: "csv" | "fetched",
  now: string,
): ImportSummary {
  const funds = new Set<string>();
  let prices = 0;
  db.transaction((tx) => {
    for (const row of parsed.rows) {
      for (const [symbol, price] of row.prices) {
        setFundPrice(tx, symbol, row.date, price, source, now);
        funds.add(symbol);
        prices += 1;
      }
    }
  });
  const dates = parsed.rows.map((r) => r.date).sort();
  return {
    days: parsed.rows.length,
    prices,
    funds: [...funds].sort(),
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    ignoredColumns: parsed.ignoredColumns,
  };
}

export function importFundPriceCsv(db: AppDb, text: string, now: string): ImportSummary {
  const parsed = parseFundPriceCsv(text);
  if (parsed.rows.length === 0) {
    throw new AppError(400, "invalid_price_file", "That file has no dated prices in it.");
  }
  return importFundPrices(db, parsed, "csv", now);
}

/** The price on a day, or the most recent one before it (within `withinDays`), or null. */
export function priceOnOrBefore(
  db: Pick<AppDb, "select">,
  symbol: string,
  day: string,
  withinDays = 7,
): { date: string; price: number } | null {
  const row = db
    .select({ date: fundPrices.date, price: fundPrices.price })
    .from(fundPrices)
    .where(
      and(
        eq(fundPrices.symbol, symbol),
        lte(fundPrices.date, day),
        gte(fundPrices.date, addDays(day, -withinDays)),
      ),
    )
    .orderBy(desc(fundPrices.date))
    .get();
  return row ?? null;
}

/** The newest price of each fund. */
export function latestPrices(
  db: AppDb,
  symbols?: string[],
): Map<string, { date: string; price: number }> {
  const rows = db
    .select({ symbol: fundPrices.symbol, date: fundPrices.date, price: fundPrices.price })
    .from(fundPrices)
    .where(symbols && symbols.length > 0 ? inArray(fundPrices.symbol, symbols) : undefined)
    .orderBy(asc(fundPrices.date))
    .all();
  const latest = new Map<string, { date: string; price: number }>();
  for (const r of rows) latest.set(r.symbol, { date: r.date, price: r.price });
  return latest;
}

export function listFundPrices(
  db: AppDb,
  options: { symbol: string; from?: string | undefined; to?: string | undefined; limit?: number },
): StoredPrice[] {
  const fund = findKnownFund(options.symbol);
  if (!fund) throw new AppError(400, "unknown_fund", "That is not one of the TSP funds.");
  const conditions = [eq(fundPrices.symbol, fund.symbol)];
  if (options.from) conditions.push(gte(fundPrices.date, options.from));
  if (options.to) conditions.push(lte(fundPrices.date, options.to));
  return db
    .select({ symbol: fundPrices.symbol, date: fundPrices.date, price: fundPrices.price })
    .from(fundPrices)
    .where(and(...conditions))
    .orderBy(desc(fundPrices.date))
    .limit(Math.min(options.limit ?? 400, 2000))
    .all();
}

// ---- Downloading ----------------------------------------------------------------------------

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type PriceSource = "maxtsp" | "tsp.gov";
export const PRICE_SOURCES: PriceSource[] = ["maxtsp", "tsp.gov"];
/** The furthest back a download may reach (the TSP's share prices start in 2003). */
export const MAX_HISTORY_DAYS = 365 * 30;

/**
 * Where prices are downloaded from. `{from}` and `{to}` are replaced with the dates asked for.
 * `PF_TSP_PRICES_URL` overrides the address for either source.
 */
export function priceUrl(source: PriceSource, from: string, to: string): string {
  const template =
    process.env["PF_TSP_PRICES_URL"] ??
    (source === "maxtsp"
      ? "https://api.maxtsp.com/funds/prices?start_date={from}&end_date={to}"
      : "https://www.tsp.gov/data/fund-price-history.csv?startdate={from}&enddate={to}&Lfunds=1&InvFunds=1&download=1");
  return template.replace("{from}", from).replace("{to}", to);
}

/**
 * Reads the Max TSP API's answer: {"2026-10-01": {"C Fund": 123.69, "L 2050": 46.36, ...}, ...}.
 * Returns null when the text is not that shape (so it can be tried as a CSV price file instead).
 */
export function parseFundPriceJson(text: string): ParsedPrices | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const rows: PriceRow[] = [];
  const ignored = new Set<string>();
  for (const [key, day] of Object.entries(data)) {
    const date = parsePriceDate(key);
    if (date === null || typeof day !== "object" || day === null) continue;
    const prices = new Map<string, number>();
    for (const [name, value] of Object.entries(day)) {
      const fund = findKnownFund(name);
      if (!fund) ignored.add(name);
      else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        prices.set(fund.symbol, value);
      }
    }
    if (prices.size > 0) rows.push({ date, prices });
  }
  return { rows, ignoredColumns: [...ignored] };
}

const WHY_IMPORT =
  "Download the price file from tsp.gov in your browser (Share Prices, then download as CSV) and use Import price file.";

/**
 * Downloads recent prices. Two sources: the Max TSP API (api.maxtsp.com, no key needed) and tsp.gov, which tends to
 * refuse scripted downloads. A refusal is explained rather than worked around, and the price file can
 * always be imported instead.
 */
export async function fetchFundPrices(
  db: AppDb,
  options: {
    source?: PriceSource;
    /** How far back to go, in days; or give `since`, the first day wanted. */
    days?: number;
    since?: string;
    today?: string;
    now?: string;
    fetcher?: Fetcher;
  },
): Promise<ImportSummary> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const earliest = addDays(today, -MAX_HISTORY_DAYS);
  const wanted = options.since ?? addDays(today, -Math.max(options.days ?? 30, 1));
  const from = wanted < earliest ? earliest : wanted > today ? today : wanted;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetcher(priceUrl(options.source ?? "maxtsp", from, today), {
      headers: {
        accept: "application/json,text/csv;q=0.9,text/plain;q=0.8",
        "user-agent": "PersonalFinance/0.1 (a personal, local app)",
      },
      signal: controller.signal,
    });
  } catch {
    throw new AppError(
      502,
      "prices_unavailable",
      `Could not reach the price download (check your connection). ${WHY_IMPORT}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AppError(
      502,
      "prices_unavailable",
      `The price service did not give the prices (it answered ${response.status}). ${WHY_IMPORT}`,
    );
  }
  const body = await response.text();
  let parsed: ParsedPrices;
  try {
    parsed = parseFundPriceJson(body) ?? parseFundPriceCsv(body);
  } catch {
    throw new AppError(
      502,
      "prices_unavailable",
      `What came back was not a price file. ${WHY_IMPORT}`,
    );
  }
  if (parsed.rows.length === 0) {
    throw new AppError(
      502,
      "prices_unavailable",
      `No prices came back for that period. ${WHY_IMPORT}`,
    );
  }
  return importFundPrices(db, parsed, "fetched", options.now ?? new Date().toISOString());
}

export const FUND_SYMBOLS = TSP_FUNDS.map((f) => f.symbol);
