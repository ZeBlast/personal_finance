export interface Health {
  ok: boolean;
  database: boolean;
  version: string;
}

export type PlaidEnvironment = "fake" | "sandbox" | "production";

export interface Settings {
  syncCooldownMinutes: number;
  autoSyncIntervalMinutes: number;
  theme: "system" | "light" | "dark";
  currency: string;
  plaidEnvironment: PlaidEnvironment;
  plaidDaysRequested: number;
  autoBackupEnabled: boolean;
  backupsToKeep: number;
  /** The sidebar's pages in the user's order (paths); empty is the usual order. */
  navOrder: string[];
}

export interface PlaidStatus {
  environment: PlaidEnvironment;
  linkMode: "fake" | "plaid";
  credentialsSaved: { sandbox: boolean; production: boolean };
}

export interface LinkTokenResponse {
  linkToken: string;
  expiration: string;
  environment: PlaidEnvironment;
}

export interface Account {
  id: number;
  itemId: number | null;
  institutionName: string | null;
  connectionStatus: string | null;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string;
  currentBalanceMinor: number | null;
  availableBalanceMinor: number | null;
  lastBalanceUpdateAt: string | null;
  source: string;
  isManual: boolean;
  /** Left out of balances, totals, charts, and lists by the user's choice. */
  hidden: boolean;
  /** Its money counts toward totals: false when hidden, and for store credit (gift card) accounts. */
  countsInTotals: boolean;
  color: string | null;
  creditLimitMinor: number | null;
}

export interface SyncRun {
  id: number;
  itemId: number;
  institutionName: string;
  trigger: "launch" | "manual" | "interval";
  status: "running" | "success" | "error" | "offline" | "pending";
  startedAt: string;
  finishedAt: string | null;
  added: number;
  modified: number;
  removed: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SyncResult {
  runs: SyncRun[];
  skipped: Array<{
    itemId: number;
    institutionName: string;
    reason: string;
    /** For `too_soon`: when it may sync again (each connection syncs at most every 5 minutes). */
    nextAllowedAt?: string;
  }>;
}

export interface SyncStatus {
  environment: PlaidEnvironment;
  syncing: boolean;
  cooldownMinutes: number;
  intervalMinutes: number;
  items: Array<{
    itemId: number;
    institutionName: string;
    connectionStatus: ItemStatus;
    lastSuccessfulSyncAt: string | null;
    launchSyncEligibleAt: string | null;
    nextAutoSyncAt: string | null;
    syncing: boolean;
    lastRun: SyncRun | null;
  }>;
}

export interface Transaction {
  id: number;
  accountId: number;
  accountName: string;
  accountColor: string | null;
  institutionName: string | null;
  date: string;
  authorizedDate: string | null;
  /** The raw description from the bank. */
  name: string;
  /** What is shown: the user's edit, else the bank's merchant, else the description. */
  merchant: string;
  merchantEdited: boolean;
  /** The merchant's own name; `merchant` shows its group's name when it is in a group. */
  merchantOriginal: string;
  merchantGroup: { id: number; name: string } | null;
  providerMerchant: string;
  /** Positive = money left the account; negative = money came in. */
  amountMinor: number;
  currency: string;
  pending: boolean;
  /** The bank's own category labels, kept for reference. */
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  /** The category in use and how it was chosen. */
  category: {
    id: number;
    name: string;
    color: string | null;
    active: boolean;
    source: "manual" | "rule";
    ruleName: string | null;
  } | null;
  recipient: string | null;
  recipientSource: "plaid" | "parsed" | "manual" | null;
  providerRecipient: string | null;
  /** Who sent the money, for money coming in. */
  sender: string | null;
  senderSource: "plaid" | "parsed" | "manual" | null;
  providerSender: string | null;
  /** `manual` for a transaction entered by hand, which can be edited in full. */
  source: "plaid" | "manual";
  /** A transfer between the user's own accounts: neither income nor spending. */
  isTransfer: boolean;
  /** Who decided: `auto` (matched with the other side), `manual` (the user), `system`, or null. */
  transferSource: "auto" | "manual" | "system" | "category" | "mirror" | null;
  /**
   * The same purchase on another account (PayPal and the card that paid): `copy` when this row is
   * left out of totals, `counts` when this row counts and `with` is the copy.
   */
  mirror: {
    role: "copy" | "counts";
    source: "auto" | "manual";
    with: NonNullable<Transaction["transferWith"]>;
  } | null;
  /** A PayPal transaction older than every other connected account's history. */
  beforeOtherHistory: boolean;
  /** For a refund linked to the charge it gives back: that charge. */
  refundOf: (NonNullable<Transaction["transferWith"]> & { amountMinor: number }) | null;
  /** For a charge: how much linked refunds have given back (cents, positive). */
  refundedMinor: number;
  /** The parts it is split into across categories (empty when not split). */
  splits: Array<{
    id: number;
    categoryId: number | null;
    categoryName: string | null;
    categoryColor: string | null;
    /** Same sign as the transaction: positive is money out. */
    amountMinor: number;
    note: string | null;
  }>;
  /** False when the parts no longer add up to the amount (it then counts whole). */
  splitValid: boolean;
  /** For an automatic match, the other side of the transfer. */
  /** The app added this as the other side of a transfer linked by hand to this account. */
  createdForTransfer: boolean;
  transferWith: {
    id: number;
    accountName: string;
    institutionName: string | null;
    accountType: string;
    date: string;
    transactionDate: string;
    merchant: string;
  } | null;
  /** `credit`, `loan`, `depository`, ... of this transaction's account. */
  accountType: string;
  paymentChannel: string | null;
  /** Whether it was bought online: the user's call if there is one, else the bank's channel. */
  online: boolean;
  /** True when the user set `online` by hand. */
  onlineEdited: boolean;
  /** What the bank's channel says: true online, false in store, null when it does not say. */
  providerOnline: boolean | null;
  /** For a purchase: whether the best card was used, and its estimated cashback (never part of a balance). */
  cashback?: {
    status: "best" | "card" | "missed";
    cashbackMinor: number;
    rateBps: number;
    bestRateBps: number;
    bestCard: string | null;
    online: boolean;
  } | null;
  /** What the bank and Plaid sent beyond the basics; every part may be null or empty. */
  details: TransactionDetails;
  notes: string | null;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
  active: boolean;
  /** How money coming in under it counts: taxable income, a refund, or the usual rules (null). */
  incomeTreatment: "income" | "refund" | "transfer" | null;
  transactionCount: number;
  ruleCount: number;
}

export type RuleField = "merchant" | "name" | "recipient" | "sender" | "plaid_category";
export type RuleOperator = "equals" | "contains" | "starts_with" | "same_merchant";

export interface Rule {
  id: number;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  categoryId: number;
  categoryName: string;
  categoryActive: boolean;
  priority: number;
  enabled: boolean;
}

export interface RulePreview {
  matchCount: number;
  sample: Array<{ id: number; date: string; merchant: string; amountMinor: number }>;
}

export interface ApplyResult {
  examined: number;
  changed: number;
}

/** `txdate` is the transaction date (when it was made); `date` is the posted date. */
export type TransactionSort =
  | "txdate_desc"
  | "txdate_asc"
  | "date_desc"
  | "date_asc"
  | "amount_asc"
  | "amount_desc"
  | "merchant_asc"
  | "merchant_desc";

export interface TransactionPage {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreditLimitEntry {
  id: number;
  limitMinor: number;
  currency: string;
  effectiveDate: string;
  source: "plaid" | "manual";
  note: string | null;
  changeMinor: number | null;
  changePercent: number | null;
}

export interface CreditLimitHistory {
  current: { limitMinor: number; effectiveDate: string; source: string } | null;
  entries: CreditLimitEntry[];
}

export type ItemStatus = "active" | "login_required" | "error";

export interface PlaidItem {
  id: number;
  institutionId: string | null;
  institutionName: string;
  /** The institution's logo (an image data URL), when it has been looked up. */
  logo: string | null;
  environment: PlaidEnvironment;
  status: ItemStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  daysRequested: number;
  lastSuccessfulSyncAt: string | null;
  createdAt: string;
  /** Belongs to the real app (this is a development copy): read-only here. */
  borrowed: boolean;
  accounts: Account[];
}

export interface ExchangeResult {
  item: PlaidItem;
  warning?: string;
  duplicateOfItemId?: number;
}

export interface FakeInstitution {
  id: string;
  name: string;
  accountCount: number;
}

export interface TransactionDetails {
  /** The time of day (ISO 8601), when the bank reports one. */
  datetime: string | null;
  authorizedDatetime: string | null;
  /** The bank's own wording, before cleanup. */
  originalDescription: string | null;
  location: {
    address: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    lat: number | null;
    lon: number | null;
    storeNumber: string | null;
  } | null;
  merchant: {
    entityId: string | null;
    categoryCode: string | null;
    logoUrl: string | null;
    website: string | null;
  } | null;
  /** VERY_HIGH, HIGH, MEDIUM, LOW, or UNKNOWN. */
  categoryConfidence: string | null;
  payment: {
    method: string | null;
    processor: string | null;
    reference: string | null;
    reason: string | null;
    byOrderOf: string | null;
    ppdId: string | null;
  } | null;
  counterparties: Array<{
    name: string;
    type: string;
    entityId: string | null;
    website: string | null;
    logoUrl: string | null;
    confidenceLevel: string | null;
  }>;
}
