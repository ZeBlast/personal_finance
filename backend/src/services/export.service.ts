import fs from "node:fs";
import path from "node:path";
import {
  accounts,
  appSettings,
  balanceSnapshots,
  budgets,
  attachments,
  cardBills,
  cashbackRules,
  duplicateDismissals,
  sandboxSaves,
  subscriptionReviews,
  fundPrices,
  tspAllocations,
  tspContributionApplications,
  tspContributions,
  dayNotes,
  plannedExceptions,
  plannedTransactions,
  categories,
  creditLimitHistory,
  dashboardWidgets,
  holdings,
  holdingSnapshots,
  investmentTransactions,
  plaidItems,
  securities,
  transactionRules,
  transactions,
  transactionSplits,
  goals,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { toCsv, type CsvCell } from "../utils/csv-write.js";
import { AppError } from "../utils/errors.js";
import { minorUnitDigits } from "../utils/money.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";
import { portfolioHoldings, portfolioTransactions } from "./portfolio.service.js";
import { listTransactions } from "./transaction.service.js";

/**
 * Exports write a file into `<data folder>/exports` and report where it is, so the same code
 * works in the app window and in a browser tab. Nothing secret is ever exported: connection
 * tokens and saved Plaid credentials are left out of every export.
 */

export const EXPORT_KINDS = [
  "transactions",
  "accounts",
  "investment-holdings",
  "investment-transactions",
  "everything",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportResult {
  kind: ExportKind;
  name: string;
  path: string;
  sizeBytes: number;
  rows: number;
}

export const exportDir = (dataDir: string): string => path.join(dataDir, "exports");

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");

/** Whole minor units as a plain decimal ("1234" cents -> "12.34"), with no currency symbol. */
function money(minor: number | null, currency: string): string | null {
  if (minor === null) return null;
  const digits = minorUnitDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

const flip = (minor: number): number => (minor === 0 ? 0 : -minor);

function transactionsCsv(db: AppDb): { text: string; rows: number } {
  const environment = getSettings(db).plaidEnvironment;
  const rows: CsvCell[][] = [];
  for (let page = 1; ; page += 1) {
    const result = listTransactions(db, { page, pageSize: 1000, environment, sort: "date_desc" });
    for (const t of result.items) {
      rows.push([
        t.date,
        t.accountName,
        t.institutionName ?? "",
        t.merchant,
        t.name,
        // The way the app shows it: money out is negative, money in is positive.
        money(flip(t.amountMinor), t.currency),
        t.currency,
        t.category?.name ?? "",
        t.pending,
        t.isTransfer,
        t.recipient ?? "",
        t.sender ?? "",
        t.notes ?? "",
      ]);
    }
    if (page * 1000 >= result.total) break;
  }
  return {
    text: toCsv(
      [
        "date",
        "account",
        "institution",
        "merchant",
        "description",
        "amount (money in is positive)",
        "currency",
        "category",
        "pending",
        "transfer",
        "recipient",
        "sender",
        "notes",
      ],
      rows,
    ),
    rows: rows.length,
  };
}

function accountsCsv(db: AppDb): { text: string; rows: number } {
  const environment = getSettings(db).plaidEnvironment;
  const list = listAccounts(db, undefined, true).filter(
    (a) => a.itemId === null || a.connectionEnvironment === environment,
  );
  return {
    text: toCsv(
      [
        "account",
        "institution",
        "type",
        "subtype",
        "currency",
        "current balance",
        "available balance",
        "credit limit",
        "source",
        "balance updated",
      ],
      list.map((a) => [
        a.name,
        a.institutionName ?? "",
        a.type,
        a.subtype ?? "",
        a.currency,
        money(a.currentBalanceMinor, a.currency),
        money(a.availableBalanceMinor, a.currency),
        money(a.creditLimitMinor, a.currency),
        a.isManual ? "entered by hand" : "connected",
        a.lastBalanceUpdateAt ?? "",
      ]),
    ),
    rows: list.length,
  };
}

function holdingsCsv(db: AppDb): { text: string; rows: number } {
  const list = portfolioHoldings(db, {});
  return {
    text: toCsv(
      ["account", "symbol", "name", "type", "quantity", "price", "value", "cost basis", "as of"],
      list.map((h) => [
        h.accountName ?? "",
        h.symbol ?? "",
        h.name,
        h.assetClass,
        h.quantity,
        h.price,
        money(h.valueMinor, "USD"),
        money(h.costBasisMinor, "USD"),
        h.asOf,
      ]),
    ),
    rows: list.length,
  };
}

function investmentTransactionsCsv(db: AppDb): { text: string; rows: number } {
  const { rows: list } = portfolioTransactions(db, { limit: 1_000_000, offset: 0 });
  return {
    text: toCsv(
      [
        "date",
        "account",
        "type",
        "description",
        "symbol",
        "quantity",
        "price",
        "cash (money in is positive)",
        "fees",
        "currency",
        "source",
      ],
      list.map((t) => [
        t.date,
        t.accountName ?? "",
        t.type,
        t.name,
        t.symbol ?? "",
        t.quantity,
        t.price,
        money(flip(t.amountMinor), t.currency),
        money(t.feesMinor, t.currency),
        t.currency,
        t.source,
      ]),
    ),
    rows: list.length,
  };
}

/** Every table that holds the user's data, as JSON. Connection tokens and credentials are excluded. */
function everythingJson(db: AppDb, now: Date): { text: string; rows: number } {
  const tables = {
    connections: db
      .select({
        id: plaidItems.id,
        institutionName: plaidItems.institutionName,
        environment: plaidItems.environment,
        status: plaidItems.status,
        lastSuccessfulSyncAt: plaidItems.lastSuccessfulSyncAt,
      })
      .from(plaidItems)
      .all(),
    accounts: db.select().from(accounts).all(),
    transactions: db.select().from(transactions).all(),
    transactionSplits: db.select().from(transactionSplits).all(),
    goals: db.select().from(goals).all(),
    categories: db.select().from(categories).all(),
    rules: db.select().from(transactionRules).all(),
    budgets: db.select().from(budgets).all(),
    cashbackRules: db.select().from(cashbackRules).all(),
    cardBills: db.select().from(cardBills).all(),
    subscriptionReviews: db.select().from(subscriptionReviews).all(),
    duplicateDismissals: db.select().from(duplicateDismissals).all(),
    sandboxSaves: db.select().from(sandboxSaves).all(),
    // The files themselves stay in the database (and its backups); the export lists them.
    attachments: db
      .select({
        id: attachments.id,
        transactionId: attachments.transactionId,
        name: attachments.name,
        mime: attachments.mime,
        size: attachments.size,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .all(),
    fundPrices: db.select().from(fundPrices).all(),
    tspAllocations: db.select().from(tspAllocations).all(),
    tspContributions: db.select().from(tspContributions).all(),
    tspContributionApplications: db.select().from(tspContributionApplications).all(),
    creditLimitHistory: db.select().from(creditLimitHistory).all(),
    balanceSnapshots: db.select().from(balanceSnapshots).all(),
    securities: db.select().from(securities).all(),
    holdings: db.select().from(holdings).all(),
    holdingSnapshots: db.select().from(holdingSnapshots).all(),
    investmentTransactions: db.select().from(investmentTransactions).all(),
    dashboardWidgets: db.select().from(dashboardWidgets).all(),
    dayNotes: db.select().from(dayNotes).all(),
    plannedTransactions: db.select().from(plannedTransactions).all(),
    plannedExceptions: db.select().from(plannedExceptions).all(),
    settings: db.select().from(appSettings).all(),
  };
  const rows = Object.values(tables).reduce((sum, list) => sum + list.length, 0);
  return {
    text: JSON.stringify(
      {
        format: "personal-finance-export",
        version: 1,
        exportedAt: now.toISOString(),
        note: "Amounts are whole minor units (cents). Bank amounts are positive when money leaves the account. Connection tokens and saved Plaid credentials are not included.",
        ...tables,
      },
      null,
      2,
    ),
    rows,
  };
}

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

export function runExport(
  db: AppDb,
  dataDir: string,
  kind: ExportKind,
  now = new Date(),
): ExportResult {
  const built =
    kind === "transactions"
      ? transactionsCsv(db)
      : kind === "accounts"
        ? accountsCsv(db)
        : kind === "investment-holdings"
          ? holdingsCsv(db)
          : kind === "investment-transactions"
            ? investmentTransactionsCsv(db)
            : everythingJson(db, now);
  const extension = kind === "everything" ? "json" : "csv";
  const dir = exportDir(dataDir);
  const name = `pf-export-${kind}-${stamp(now)}.${extension}`;
  const file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A byte-order mark makes Excel read the UTF-8 text of a CSV correctly.
    fs.writeFileSync(file, (extension === "csv" ? "﻿" : "") + built.text, "utf8");
  } catch (error) {
    throw new AppError(
      500,
      "export_failed",
      `The export could not be written (${error instanceof Error ? error.message : "unknown error"}).`,
    );
  }
  return { kind, name, path: file, sizeBytes: fs.statSync(file).size, rows: built.rows };
}
