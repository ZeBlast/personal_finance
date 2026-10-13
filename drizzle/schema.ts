import {
  index,
  blob,
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
  /** The institution's logo as a data URL, and its brand color, when Plaid has them. */
  institutionLogo: text("institution_logo"),
  institutionColor: text("institution_color"),
  /** When the logo was last looked up, so a missing one is not asked for again and again. */
  brandingCheckedAt: text("branding_checked_at"),
  /** AES-256-GCM encrypted Plaid access token. Never returned by the API or written to logs. */
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  /** `active`, `login_required` (user must re-authenticate), or `error`. */
  status: text("status").notNull().default("active"),
  /** Plaid's error code and a short safe message; never a token or full provider payload. */
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  /** History length requested when the Item was created; Plaid fixes it at that point. */
  daysRequested: integer("days_requested").notNull(),
  /**
   * A connection that belongs to ANOTHER install of the app (a development copy borrowing the real
   * app's access token). It can read, but never disconnects, repairs, or otherwise changes the
   * connection at Plaid, and it syncs only when asked: the real app owns it.
   */
  borrowed: integer("borrowed", { mode: "boolean" }).notNull().default(false),
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
    /**
     * Set by the user to keep the account out of balances, totals, charts, and lists. It is still
     * synced and stored, and showing it again brings everything back.
     */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /** `plaid` or `manual`. */
    source: text("source").notNull().default("plaid"),
    /** Display color used by lists and the calendar. */
    color: text("color"),
    /**
     * For a credit card: the day of the month its statement closes (1-31; a later day than the
     * month has means its last day), set by the user. Null: no statement periods.
     */
    statementClosingDay: integer("statement_closing_day"),
    /** For a credit card: the day of the month its payment is due, after the statement closes. */
    statementDueDay: integer("statement_due_day"),
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
    /**
     * Everything else Plaid says about the transaction, kept as sent and never edited by the user.
     * The first counterparty above is the one used for display; all of them are here.
     */
    counterpartiesJson: text("counterparties_json"),
    /** The time of day, when the institution reports one (ISO 8601 with offset). */
    datetime: text("datetime"),
    authorizedDatetime: text("authorized_datetime"),
    /** The institution's own wording, before Plaid cleaned it up. */
    originalDescription: text("original_description"),
    locationAddress: text("location_address"),
    locationCity: text("location_city"),
    locationRegion: text("location_region"),
    locationPostalCode: text("location_postal_code"),
    locationCountry: text("location_country"),
    locationLat: real("location_lat"),
    locationLon: real("location_lon"),
    locationStoreNumber: text("location_store_number"),
    /** Plaid's merchant record: a stable ID, the merchant category code, a logo and website. */
    merchantEntityId: text("merchant_entity_id"),
    merchantCategoryCode: text("merchant_category_code"),
    logoUrl: text("logo_url"),
    website: text("website"),
    /** How Plaid is about its category guess: VERY_HIGH, HIGH, MEDIUM, LOW or UNKNOWN. */
    categoryConfidence: text("category_confidence"),
    /** Payment details the institution supplies (all optional). */
    paymentMethod: text("payment_method"),
    paymentProcessor: text("payment_processor"),
    paymentReference: text("payment_reference"),
    paymentReason: text("payment_reason"),
    paymentByOrderOf: text("payment_by_order_of"),
    paymentPpdId: text("payment_ppd_id"),
    /** Person on the other side of a transfer such as Zelle, and how it was found. */
    recipient: text("recipient"),
    /** `plaid` (provider metadata) or `parsed` (read from the description). */
    recipientSource: text("recipient_source"),
    /** Who sent the money, for money coming IN (the recipient field is for money going out). */
    sender: text("sender"),
    senderSource: text("sender_source"),
    /** `plaid` for bank transactions, `manual` for ones the user entered (those can be fully edited). */
    source: text("source").notNull().default("plaid"),
    /**
     * Money moving between the user's own accounts, which is neither income nor spending. Sending
     * money to, or receiving it from, another person is not a transfer in this sense.
     */
    isTransfer: integer("is_transfer", { mode: "boolean" }).notNull().default(false),
    /**
     * Why `is_transfer` has its value: `auto` (matched with an equal and opposite transaction on
     * another of the user's accounts), `manual` (the user decided; detection never changes it),
     * `system` (an opening balance), or null (never flagged).
     */
    transferSource: text("transfer_source"),
    /** For an automatic match, the transaction on the other account (or one linked by hand). */
    transferPairId: integer("transfer_pair_id"),
    /**
     * Made by the app as the other side of a transfer the user linked to an account they keep by
     * hand; unlinking removes it.
     */
    createdForTransfer: integer("created_for_transfer", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * This row is a copy of one purchase that another account also shows: a PayPal purchase and
     * the card charge that paid for it. The copy points at the row that counts
     * (`transfer_source = 'mirror'` keeps the copy out of income and spending).
     */
    mirrorOfId: integer("mirror_of_id"),
    /** Who linked the copy: `auto` (detection; redone on every run) or `manual` (the user). */
    mirrorSource: text("mirror_source"),
    /** The user unlinked a copy: detection never links this row as a copy again. */
    mirrorBlocked: integer("mirror_blocked", { mode: "boolean" }).notNull().default(false),
    /**
     * For a refund (money back), the charge it gives back, chosen by the user. Totals then count it
     * against that charge: in its category, on its date, and never as income.
     */
    refundOfId: integer("refund_of_id"),
    /** Who linked the refund: `auto` (detection; redone on every run) or `manual` (the user). */
    refundSource: text("refund_source"),
    /** The user said this is not a refund (of that charge): detection never links it again. */
    refundBlocked: integer("refund_blocked", { mode: "boolean" }).notNull().default(false),
    // User edits: never overwritten by a sync.
    merchantNameUser: text("merchant_name_user"),
    recipientUser: text("recipient_user"),
    senderUser: text("sender_user"),
    notesUser: text("notes_user"),
    /** The user's call on whether this was an online purchase; null means use the bank's payment channel. */
    onlineUser: integer("online_user", { mode: "boolean" }),
    /** When the user marked it as looked at in the review queue (null: not yet). */
    reviewedAt: text("reviewed_at"),
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
    /**
     * How money coming in under this category counts: `income` (taxable income, such as a credit
     * that is really earnings), `refund` (money given back: it lowers spending and is never
     * income), or null (the usual rules decide).
     */
    incomeTreatment: text("income_treatment"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("categories_parent_idx").on(table.parentId)],
);

/**
 * One transaction divided across categories (a store run that was part groceries, part home).
 * The parts add up to the transaction's amount; totals and budgets count each part in its own
 * category through the `transaction_lines` view (see the migration that adds it), and only while
 * the parts still add up (a bank changing the amount makes the transaction count whole again).
 */
export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Same sign as the transaction's amount: positive is money out. */
    amountMinor: integer("amount_minor").notNull(),
    note: text("note"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("transaction_splits_transaction_idx").on(table.transactionId)],
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

/** The user's own note for one calendar day. A day with no note has no row. */
export const dayNotes = sqliteTable("day_notes", {
  date: text("date").primaryKey(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * A transaction the user expects, once or on a schedule (rent, a paycheck, a subscription).
 * `amount_minor` follows the transaction sign convention: positive is money out, negative is money
 * in. The repeat rule is stored as plain columns and expanded into dates by `utils/recurrence.ts`.
 */
export const plannedTransactions = sqliteTable("planned_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** The account it will hit, if the user knows; otherwise it counts under "All accounts" only. */
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "set null" }),
  merchant: text("merchant").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
  /** The recipient (money out) or sender (money in). */
  person: text("person"),
  notes: text("notes"),
  startDate: text("start_date").notNull(),
  /** `once`, `daily`, `weekly`, `monthly`, or `yearly`. */
  frequency: text("frequency").notNull(),
  /** Repeat every N days, weeks, months, or years. */
  repeatEvery: integer("repeat_every").notNull().default(1),
  /** Weekly: the days of the week to repeat on, as 0 (Sunday) to 6 comma separated. */
  weekdays: text("weekdays"),
  /** Monthly: `day` (the same date each month) or `weekday` (such as the 2nd Tuesday). */
  monthMode: text("month_mode"),
  /** Monthly by day: 1 to 31, or -1 for the last day of the month. */
  dayOfMonth: integer("day_of_month"),
  /** Monthly by weekday: 1 to 4, or -1 for the last, of the weekday in `weekdays`. */
  nthWeek: integer("nth_week"),
  endDate: text("end_date"),
  /** Stop after this many occurrences. */
  maxCount: integer("max_count"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One occurrence of a planned transaction that was skipped or handled, so it stops being "expected". */
export const plannedExceptions = sqliteTable(
  "planned_exceptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    plannedId: integer("planned_id")
      .notNull()
      .references(() => plannedTransactions.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    /**
     * `skipped` (it did not happen), `done` (it happened, or was recorded as a transaction), or
     * `changed` (this one occurrence moves to `moveTo` and/or takes `amountMinor`; the series
     * stays as it is).
     */
    kind: text("kind").notNull(),
    /** For `changed`: the day this occurrence happens instead (null keeps its day). */
    moveTo: text("move_to"),
    /** For `changed`: its amount instead, signed like the plan's (null keeps the plan's). */
    amountMinor: integer("amount_minor"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("planned_exceptions_unique").on(table.plannedId, table.date)],
);

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
  /** Identifiers and descriptive data Plaid provides (all optional; manual funds may fill them in too). */
  isin: text("isin"),
  cusip: text("cusip"),
  sedol: text("sedol"),
  figi: text("figi"),
  cfiCode: text("cfi_code"),
  institutionSecurityId: text("institution_security_id"),
  proxySecurityId: text("proxy_security_id"),
  marketIdentifierCode: text("market_identifier_code"),
  isCashEquivalent: integer("is_cash_equivalent", { mode: "boolean" }),
  subtype: text("subtype"),
  closePrice: real("close_price"),
  closePriceAsOf: text("close_price_as_of"),
  sector: text("sector"),
  industry: text("industry"),
  optionContractType: text("option_contract_type"),
  optionExpiration: text("option_expiration"),
  optionStrike: real("option_strike"),
  optionUnderlying: text("option_underlying"),
  fixedYieldRate: real("fixed_yield_rate"),
  fixedYieldType: text("fixed_yield_type"),
  fixedMaturityDate: text("fixed_maturity_date"),
  fixedIssueDate: text("fixed_issue_date"),
  fixedFaceValue: real("fixed_face_value"),
  providerUpdatedAt: text("provider_updated_at"),
  /** The complete security object exactly as the provider sent it, so nothing it supplies is lost. */
  rawJson: text("raw_json"),
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
    /** The part of the position that has vested (a retirement plan's employer money, for example). */
    vestedQuantity: real("vested_quantity"),
    vestedValueMinor: integer("vested_value_minor"),
    /** The price's own date and time as the provider gave them. */
    priceAsOf: text("price_as_of"),
    priceDatetime: text("price_datetime"),
    /** The complete holding object as the provider sent it, including its tax lots. */
    rawJson: text("raw_json"),
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
    /** The provider's own finer label (for example "employer match" or "qualified dividend"). */
    subtype: text("subtype"),
    transactionDatetime: text("transaction_datetime"),
    /** Set on a cancellation: the provider ID of the transaction it cancels. */
    cancelTransactionId: text("cancel_transaction_id"),
    rawJson: text("raw_json"),
    /** `plaid` or `manual`. */
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("investment_tx_account_date_idx").on(table.accountId, table.date)],
);

/**
 * The daily price of one unit of a fund (the TSP's funds, for now): from a price file the user
 * imported, fetched online, or typed in. One price per fund per day.
 */
export const fundPrices = sqliteTable(
  "fund_prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The fund's symbol as used for holdings, such as `TSP-C`. */
    symbol: text("symbol").notNull(),
    date: text("date").notNull(),
    price: real("price").notNull(),
    /** `csv`, `fetched`, or `manual`. */
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("fund_prices_symbol_date_unique").on(table.symbol, table.date)],
);

/** How new contributions to a manual TSP account are split between funds (basis points of 100%). */
export const tspAllocations = sqliteTable(
  "tsp_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    percentBps: integer("percent_bps").notNull(),
  },
  (table) => [
    uniqueIndex("tsp_allocations_account_symbol_unique").on(table.accountId, table.symbol),
  ],
);

/**
 * A recurring dollar amount going into a manual TSP account, split by its allocation. Each time it
 * comes due it is turned into fund units at that day's price and added to the holdings.
 */
export const tspContributions = sqliteTable("tsp_contributions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  amountMinor: integer("amount_minor").notNull(),
  /** `weekly`, `biweekly`, `semimonthly` (two set days a month), or `monthly`. */
  frequency: text("frequency").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  /** Monthly and semimonthly: the day of the month (1 to 31, or -1 for the last day). */
  dayOfMonth: integer("day_of_month"),
  /** Semimonthly: the second day of the month. */
  secondDayOfMonth: integer("second_day_of_month"),
  /**
   * Employer money added on each contribution day: `fers` (the federal agency's 1% automatic plus
   * its match of the first 5% of pay), `custom` (matchPercent of what you put in, up to
   * matchUpToPercent of pay, plus autoPercent of pay), or null for none.
   */
  matchPlan: text("match_plan"),
  /** Gross pay for each contribution period, which the match is worked out from. */
  payMinor: integer("pay_minor"),
  matchPercent: real("match_percent"),
  matchUpToPercent: real("match_up_to_percent"),
  autoPercent: real("auto_percent"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** One contribution turned into units of one fund on one day, so it is never applied twice. */
export const tspContributionApplications = sqliteTable(
  "tsp_contribution_applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contributionId: integer("contribution_id")
      .notNull()
      .references(() => tspContributions.id, { onDelete: "cascade" }),
    /** The day it was due. */
    date: text("date").notNull(),
    symbol: text("symbol").notNull(),
    /** The day whose price was used (the due day, or the last business day before it). */
    priceDate: text("price_date").notNull(),
    price: real("price").notNull(),
    units: real("units").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    /** Of `amountMinor` (and the units), the part the employer put in. */
    employerMinor: integer("employer_minor").notNull().default(0),
    appliedAt: text("applied_at").notNull(),
  },
  (table) => [
    uniqueIndex("tsp_applications_unique").on(table.contributionId, table.date, table.symbol),
  ],
);

/**
 * How much cashback a credit card earns: a percentage for a category (a purchase in a subcategory
 * uses its parent's rate when it has none of its own), and optionally one for everything else (the
 * row with no category). The rate is in basis points: 150 is 1.5%.
 */
export const cashbackRules = sqliteTable(
  "cashback_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Null means "everything else". */
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "cascade" }),
    rateBps: integer("rate_bps").notNull(),
    /** True for a rate that applies only to online purchases. */
    onlineOnly: integer("online_only", { mode: "boolean" }).notNull().default(false),
    /** A merchant name (matched case-insensitively, anywhere in the name) for a merchant rule. */
    merchant: text("merchant"),
    /** True for an exclusion: the merchant earns nothing from the category (or from any rate, when no category). */
    exclude: integer("exclude", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("cashback_rules_account_idx").on(table.accountId)],
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

/**
 * A credit card's billing cycle, set by the user: the day its statement closes and the day payment
 * is due. With those, the app works out each statement's balance and whether it has been paid.
 */
export const cardBills = sqliteTable("card_bills", {
  accountId: integer("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** Day of the month the statement closes (1-31; a short month uses its last day). */
  closingDay: integer("closing_day").notNull(),
  /** Day of the month the payment is due (1-31), in the month after the statement closes. */
  dueDay: integer("due_day").notNull(),
  /** The minimum payment the issuer asks for, when known. */
  minimumMinor: integer("minimum_minor"),
  /** The card pays itself from another account. */
  autopay: integer("autopay", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** The user's decision about a recurring charge: keep it, or cancel it. */
export const subscriptionReviews = sqliteTable("subscription_reviews", {
  /** The recurring series' key (see recurring.service). */
  key: text("key").primaryKey(),
  merchant: text("merchant").notNull(),
  /** `keep`, `cancel` (meaning to), or `cancelled` (done). */
  status: text("status").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").notNull(),
});

/** A file attached to a transaction (a receipt, a warranty), kept inside the encrypted database. */
export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("attachments_transaction_idx").on(table.transactionId)],
);

/** Two transactions the user said are not duplicates of each other. */
export const duplicateDismissals = sqliteTable("duplicate_dismissals", {
  /** "smaller id:larger id". */
  pairKey: text("pair_key").primaryKey(),
  createdAt: text("created_at").notNull(),
});

/** Named copies of a sandbox drawing (the maths nodes or the cash-flow map), to load again later. */
export const sandboxSaves = sqliteTable(
  "sandbox_saves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "math" or "flow". */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** The drawing, as the page saves it (JSON). */
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("sandbox_saves_kind_idx").on(table.kind)],
);

/**
 * A savings goal: a target amount, by a date or open-ended. Progress is the current balance of
 * the accounts linked to it plus an amount the user keeps by hand (money set aside elsewhere).
 */
export const goals = sqliteTable("goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  targetMinor: integer("target_minor").notNull(),
  /** `YYYY-MM-DD`, or null for no deadline. */
  targetDate: text("target_date"),
  /** Saved toward it outside the linked accounts, entered by hand. */
  savedMinor: integer("saved_minor").notNull().default(0),
  /** The linked accounts' IDs, as a JSON array. */
  accountIds: text("account_ids").notNull().default("[]"),
  color: text("color"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Items in a collection account (trading cards, coins, ...): what each is, how many, and what one is
 * worth. The account's balance is the sum of quantity × value, so the collection counts in net
 * worth. `itemKey` identifies the same item across imports, so importing a newer export merges.
 */
export const collectionItems = sqliteTable(
  "collection_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    name: text("name").notNull(),
    /** A printing or version, such as "Poke Ball Pattern"; empty for the regular one. */
    variant: text("variant").notNull().default(""),
    /** For cards: the set code (PBL) and the number in the set (056/084). */
    setCode: text("set_code").notNull().default(""),
    number: text("number").notNull().default(""),
    quantity: integer("quantity").notNull().default(1),
    /** What one is worth now, in cents; null when not known yet (it then counts as nothing). */
    unitValueMinor: integer("unit_value_minor"),
    /** What one cost, in cents, when known. */
    unitCostMinor: integer("unit_cost_minor"),
    condition: text("condition"),
    notes: text("notes"),
    /** TCGplayer's product id, looked up from the set code and number (prices are fetched by it). */
    tcgplayerId: text("tcgplayer_id"),
    /** Where the value came from: typed in ("manual", kept as is) or the market price ("market"). */
    valueSource: text("value_source"),
    /** The JustTCG variant (card, condition, printing) this item is priced as, once matched. */
    priceVariantId: text("price_variant_id"),
    /** What it matched, for showing ("Pikachu · Near Mint · Holofoil"). */
    priceMatchLabel: text("price_match_label"),
    /** "matched", or "not_found" when a search found nothing; null before any search. */
    priceMatchStatus: text("price_match_status"),
    /** The latest market price of one, in cents, and when it was fetched. */
    marketPriceMinor: integer("market_price_minor"),
    priceUpdatedAt: text("price_updated_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("collection_items_account_key").on(table.accountId, table.itemKey)],
);

/** Market price history of a collection item: one price per day, from the price service. */
export const collectionPriceHistory = sqliteTable(
  "collection_price_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => collectionItems.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    priceMinor: integer("price_minor").notNull(),
  },
  (table) => [uniqueIndex("collection_price_history_item_day").on(table.itemId, table.day)],
);

/** Merchants the user grouped as one (several names for one place, such as Amazon's). */
export const merchantGroups = sqliteTable("merchant_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** The merchants in a group, by their normalized name (see merchantKey); one group each. */
export const merchantGroupMembers = sqliteTable(
  "merchant_group_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupId: integer("group_id")
      .notNull()
      .references(() => merchantGroups.id, { onDelete: "cascade" }),
    merchantKey: text("merchant_key").notNull(),
    /** The name as it was shown when added, for listing. */
    merchantName: text("merchant_name").notNull(),
  },
  (table) => [uniqueIndex("merchant_group_members_key").on(table.merchantKey)],
);
