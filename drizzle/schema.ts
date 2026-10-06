import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/**
 * Money is always stored as integer minor units (cents for USD) to avoid floating-point errors.
 * Timestamps are ISO-8601 UTC strings.
 */

/**
 * Key/value application settings (sync cooldown, theme, default currency, ...).
 * Values are stored as JSON text; the settings service parses and validates them.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Secrets the user typed in (for example the Plaid client ID and secret), encrypted at rest with
 * the same key as the Plaid access tokens. The API never returns these values.
 */
export const credentials = sqliteTable("credentials", {
  key: text("key").primaryKey(),
  valueEncrypted: text("value_encrypted").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One connection ("Item") to a financial institution through Plaid. */
export const plaidItems = sqliteTable("plaid_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  plaidItemId: text("plaid_item_id").notNull().unique(),
  /** `fake` (built-in demo data), `sandbox`, or `production`. Items belong to one environment. */
  environment: text("environment").notNull(),
  institutionId: text("institution_id"),
  institutionName: text("institution_name").notNull(),
  /** AES-256-GCM encrypted Plaid access token. Never returned by the API or written to logs. */
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  /** `active`, `login_required` (user must re-authenticate), or `error`. */
  status: text("status").notNull().default("active"),
  /** Plaid's error code and a short safe message; never a token or full provider payload. */
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  /** History length requested when the Item was created; Plaid fixes it at that point. */
  daysRequested: integer("days_requested").notNull(),
  /** Transactions sync cursor (used from Phase 3). */
  syncCursor: text("sync_cursor"),
  lastSuccessfulSyncAt: text("last_successful_sync_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** An account at an institution (from Plaid) or a manually created account (later phases). */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Null for manual accounts that have no Plaid connection. Deleting an Item deletes its accounts. */
    plaidItemId: integer("plaid_item_id").references(() => plaidItems.id, {
      onDelete: "cascade",
    }),
    plaidAccountId: text("plaid_account_id").unique(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    /** Last 2-4 digits only; full account numbers are never stored. */
    mask: text("mask"),
    currency: text("currency").notNull().default("USD"),
    currentBalanceMinor: integer("current_balance_minor"),
    availableBalanceMinor: integer("available_balance_minor"),
    lastBalanceUpdateAt: text("last_balance_update_at"),
    isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
    /** `plaid` or `manual`. */
    source: text("source").notNull().default("plaid"),
    /** Display color used by lists and the calendar. */
    color: text("color"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("accounts_plaid_item_idx").on(table.plaidItemId)],
);

/**
 * One transaction. Columns come in two kinds:
 * - provider columns, refreshed by every sync (name, merchant_name, amount, recipient, ...), and
 * - user columns (`*_user`), which only the user changes and a sync never overwrites.
 * The API shows the user value when there is one, otherwise the provider value.
 *
 * Sign convention (Plaid's): `amount_minor` is positive when money LEAVES the account (a purchase,
 * a payment out, a transfer out) and negative when money ENTERS it (income, a refund, a transfer
 * in). For a credit card, a purchase is positive and a payment to the card is negative.
 */
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    plaidTransactionId: text("plaid_transaction_id").unique(),
    /** Set on a posted transaction that replaced a pending one (Plaid gives it a new ID). */
    pendingPlaidTransactionId: text("pending_plaid_transaction_id"),
    /** Calendar date as reported by the institution (YYYY-MM-DD, no time zone). */
    date: text("date").notNull(),
    authorizedDate: text("authorized_date"),
    /** The raw description from the institution. */
    name: text("name").notNull(),
    /** Cleaned merchant name from the provider, when it has one. */
    merchantName: text("merchant_name"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    paymentChannel: text("payment_channel"),
    plaidCategoryPrimary: text("plaid_category_primary"),
    plaidCategoryDetailed: text("plaid_category_detailed"),
    counterpartyName: text("counterparty_name"),
    counterpartyType: text("counterparty_type"),
    /** Person on the other side of a transfer such as Zelle, and how it was found. */
    recipient: text("recipient"),
    /** `plaid` (provider metadata) or `parsed` (read from the description). */
    recipientSource: text("recipient_source"),
    isTransfer: integer("is_transfer", { mode: "boolean" }).notNull().default(false),
    // User edits: never overwritten by a sync.
    merchantNameUser: text("merchant_name_user"),
    recipientUser: text("recipient_user"),
    notesUser: text("notes_user"),
    /**
     * The category and how it got there: `manual` (the user chose it; rules never change it),
     * `rule` (assigned by the rule in `category_rule_id`), or null (none yet).
     */
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    categorySource: text("category_source"),
    categoryRuleId: integer("category_rule_id").references(() => transactionRules.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("transactions_date_idx").on(table.date),
    index("transactions_account_date_idx").on(table.accountId, table.date),
    index("transactions_pending_id_idx").on(table.pendingPlaidTransactionId),
    index("transactions_category_idx").on(table.categoryId),
  ],
);

/**
 * A user category, optionally under one parent (two levels at most). A category that is in use is
 * archived (`active` = false) instead of deleted, so history keeps its meaning.
 */
export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    parentId: integer("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "set null",
    }),
    /** Display color, `#rrggbb`. */
    color: text("color"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("categories_parent_idx").on(table.parentId)],
);

/**
 * "If this field matches this text, use this category." Rules run in `priority` order (lowest
 * first, ties broken by ID) and the first enabled match wins. They never change a category the
 * user chose by hand.
 */
export const transactionRules = sqliteTable("transaction_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** `merchant`, `name` (the raw description), `recipient`, or `plaid_category`. */
  field: text("field").notNull(),
  /** `equals`, `contains`, or `starts_with`; always case-insensitive. */
  operator: text("operator").notNull(),
  matchValue: text("match_value").notNull(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A monthly spending limit for a category (and its subcategories). */
export const budgets = sqliteTable(
  "budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    /** First day of the month, `YYYY-MM-01`. */
    periodStart: text("period_start").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("budgets_category_period_unique").on(table.categoryId, table.periodStart),
  ],
);

/**
 * One widget placed on the dashboard. The backend deliberately knows nothing about widget types:
 * `widget_type` is just the ID a frontend widget registered under, and `config` is whatever
 * settings that widget stores. That is what lets new widgets be added without touching the server,
 * and lets layouts survive widgets being renamed or removed in a later version.
 */
export const dashboardWidgets = sqliteTable(
  "dashboard_widgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Which dashboard the widget is on (see `dashboards`; kept in step by the service, not a constraint). */
    dashboardId: integer("dashboard_id").notNull().default(1),
    widgetType: text("widget_type").notNull(),
    /** Hidden widgets keep their place and settings. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Grid position and size, in grid columns and rows. */
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    w: integer("w").notNull(),
    h: integer("h").notNull(),
    /** JSON object of the widget's own settings. */
    config: text("config").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("dashboard_widgets_dashboard_idx").on(table.dashboardId)],
);

/**
 * A named dashboard layout. `initialized` is false until its first save, so a new dashboard can be
 * filled with the default widgets once, while one the user emptied stays empty.
 */
export const dashboards = sqliteTable("dashboards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  initialized: integer("initialized", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Recurring-looking charges or deposits the user marked "not recurring". Keyed like the insight. */
export const recurringDismissed = sqliteTable("recurring_dismissed", {
  key: text("key").primaryKey(),
  merchant: text("merchant").notNull(),
  createdAt: text("created_at").notNull(),
});

/** One attempt to synchronize a connection, kept as history and for the sync status display. */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    plaidItemId: integer("plaid_item_id")
      .notNull()
      .references(() => plaidItems.id, { onDelete: "cascade" }),
    /** `launch`, `manual`, or `interval`. */
    trigger: text("trigger").notNull(),
    /** `running`, `success`, `error`, `offline`, or `pending` (provider data not ready yet). */
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    addedCount: integer("added_count").notNull().default(0),
    modifiedCount: integer("modified_count").notNull().default(0),
    removedCount: integer("removed_count").notNull().default(0),
    /** A short safe summary only; never tokens or provider payloads. */
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [index("sync_runs_item_idx").on(table.plaidItemId, table.id)],
);

/**
 * A balance observed during a successful sync. History is only as complete as the syncs that
 * happened, so charts must show observed points and never invent values between them.
 */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    observedAt: text("observed_at").notNull(),
    currentBalanceMinor: integer("current_balance_minor"),
    availableBalanceMinor: integer("available_balance_minor"),
    currency: text("currency").notNull(),
  },
  (table) => [index("balance_snapshots_account_idx").on(table.accountId, table.observedAt)],
);

/**
 * A fund, stock, or other thing that can be held. Plaid securities and manually defined funds
 * (for example the TSP funds) share this table, so every widget treats them the same way.
 */
export const securities = sqliteTable("securities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Set for securities that came from Plaid. */
  plaidSecurityId: text("plaid_security_id").unique(),
  /** Set for manual securities: `<uppercased symbol>`; makes "the same fund" findable by symbol. */
  manualKey: text("manual_key").unique(),
  symbol: text("symbol"),
  name: text("name").notNull(),
  /** The provider's type (equity, etf, mutual fund, ...), or `fund` for manual ones. */
  securityType: text("security_type"),
  /** How the holding is grouped in allocation charts: Stocks, Bonds, Cash, Funds, Crypto, Other. */
  assetClass: text("asset_class").notNull(),
  currency: text("currency").notNull().default("USD"),
  isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * What an investment account holds right now. `value_minor` (a whole number of cents) is the
 * authoritative amount; `price` is the per-unit price as a decimal because fund prices carry
 * fractions of a cent. Cost basis is the TOTAL paid, or null when unknown.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "restrict" }),
    quantity: real("quantity").notNull(),
    price: real("price"),
    valueMinor: integer("value_minor").notNull(),
    costBasisMinor: integer("cost_basis_minor"),
    currency: text("currency").notNull(),
    /** When the provider (or the user) says the figures were true. */
    asOf: text("as_of").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("holdings_account_security_unique").on(table.accountId, table.securityId),
  ],
);

/**
 * Holdings as observed at a moment (each sync, each manual update), so portfolio value and
 * allocation can be charted over time from what was actually seen. A holding that disappears
 * simply has no later snapshots.
 */
export const holdingSnapshots = sqliteTable(
  "holding_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "restrict" }),
    observedAt: text("observed_at").notNull(),
    quantity: real("quantity").notNull(),
    valueMinor: integer("value_minor").notNull(),
    costBasisMinor: integer("cost_basis_minor"),
  },
  (table) => [index("holding_snapshots_account_idx").on(table.accountId, table.observedAt)],
);

/**
 * Buys, sells, dividends, contributions, fees and so on. Same sign convention as bank
 * transactions: `amount_minor` is positive when cash LEAVES the account (a purchase) and negative
 * when it comes in (a sale, a dividend, a contribution).
 */
export const investmentTransactions = sqliteTable(
  "investment_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id").references(() => securities.id, { onDelete: "set null" }),
    plaidInvestmentTransactionId: text("plaid_investment_transaction_id").unique(),
    /** For imported and manual rows: a fingerprint that makes importing the same file twice a no-op. */
    importKey: text("import_key").unique(),
    date: text("date").notNull(),
    /** `buy`, `sell`, `dividend`, `contribution`, `fee`, `transfer`, `other`. */
    type: text("type").notNull(),
    name: text("name").notNull(),
    quantity: real("quantity"),
    price: real("price"),
    amountMinor: integer("amount_minor").notNull(),
    feesMinor: integer("fees_minor"),
    currency: text("currency").notNull(),
    /** `plaid` or `manual`. */
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("investment_tx_account_date_idx").on(table.accountId, table.date)],
);

/**
 * Every known credit limit of a credit account, so increases and decreases can be tracked.
 * The current limit is the entry with the latest effective date that is not in the future.
 * `plaid` entries are added by sync when the reported limit differs from the current one; their
 * date is when the app NOTICED the change. `manual` entries are entered by the user and are never
 * edited or deleted by a sync.
 */
export const creditLimitHistory = sqliteTable(
  "credit_limit_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    limitMinor: integer("limit_minor").notNull(),
    currency: text("currency").notNull(),
    /** YYYY-MM-DD */
    effectiveDate: text("effective_date").notNull(),
    /** `plaid` or `manual`. */
    source: text("source").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("credit_limit_account_idx").on(table.accountId, table.effectiveDate)],
);
