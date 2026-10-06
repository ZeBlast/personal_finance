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
  skipped: Array<{ itemId: number; institutionName: string; reason: string }>;
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
  isTransfer: boolean;
  paymentChannel: string | null;
  notes: string | null;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
  active: boolean;
  transactionCount: number;
  ruleCount: number;
}

export type RuleField = "merchant" | "name" | "recipient" | "plaid_category";
export type RuleOperator = "equals" | "contains" | "starts_with";

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

export type TransactionSort =
  "date_desc" | "date_asc" | "amount_asc" | "amount_desc" | "merchant_asc" | "merchant_desc";

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
  environment: PlaidEnvironment;
  status: ItemStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  daysRequested: number;
  lastSuccessfulSyncAt: string | null;
  createdAt: string;
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
