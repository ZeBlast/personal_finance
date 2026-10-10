/**
 * The only door between this app and Plaid. Everything else in the backend talks to this
 * interface, so the app can run against built-in demo data (no network, no keys), against
 * Plaid Sandbox, or against Production without any other code knowing which.
 *
 * The interface uses this app's own types rather than Plaid's SDK types, so Plaid response
 * shapes do not leak into the database or the API.
 */

export type PlaidEnvironment = "fake" | "sandbox" | "production";

/** `banking` links accounts with transactions; `investments` links a brokerage or retirement plan. */
export type LinkKind = "banking" | "investments";

export interface LinkTokenRequest {
  /** What the user is connecting; defaults to banking. Ignored for re-authentication. */
  kind?: LinkKind;
  /** Stable identifier of the (single) local user. */
  userId: string;
  /** New connections: how many days of history to request (fixed once the Item exists). */
  daysRequested: number;
  /** Re-authentication ("update mode") for an existing Item: its access token. */
  updateAccessToken?: string;
}

export interface LinkToken {
  linkToken: string;
  /** ISO timestamp after which the token no longer works. */
  expiration: string;
}

export interface ExchangedItem {
  accessToken: string;
  itemId: string;
}

export interface ItemStatus {
  itemId: string;
  institutionId: string | null;
  /** Set when the connection is broken, for example `ITEM_LOGIN_REQUIRED`. */
  error: { code: string; message: string } | null;
}

export interface GatewayAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string;
  /** Decimal amounts as the provider reports them (for example dollars); converted at the edge. */
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
}

/** A transaction as the provider reports it. Amounts follow Plaid's sign convention (see schema). */
export interface GatewayTransaction {
  transactionId: string;
  accountId: string;
  /** Set on a posted transaction that replaces a pending one (which then appears as removed). */
  pendingTransactionId: string | null;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  amount: number;
  currency: string;
  pending: boolean;
  paymentChannel: string | null;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  counterparties: GatewayCounterparty[];
  /** Payment metadata names, when the institution provides them. */
  paymentPayee: string | null;
  paymentPayer: string | null;
  /** Everything below is optional: institutions send some of it, and the demo sends a sample. */
  /** The time of day (ISO 8601), when the institution reports one. */
  datetime?: string | null | undefined;
  authorizedDatetime?: string | null | undefined;
  /** The institution's own wording, before Plaid cleaned it up. */
  originalDescription?: string | null | undefined;
  location?: GatewayLocation | null | undefined;
  merchantEntityId?: string | null | undefined;
  merchantCategoryCode?: string | null | undefined;
  logoUrl?: string | null | undefined;
  website?: string | null | undefined;
  /** How sure Plaid is of the category: VERY_HIGH, HIGH, MEDIUM, LOW, or UNKNOWN. */
  categoryConfidence?: string | null | undefined;
  /** The rest of the payment details. */
  payment?: GatewayPaymentDetails | null | undefined;
}

export interface GatewayCounterparty {
  name: string;
  type: string;
  entityId?: string | null | undefined;
  website?: string | null | undefined;
  logoUrl?: string | null | undefined;
  confidenceLevel?: string | null | undefined;
}

export interface GatewayLocation {
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  storeNumber: string | null;
}

export interface GatewayPaymentDetails {
  method: string | null;
  processor: string | null;
  reference: string | null;
  reason: string | null;
  byOrderOf: string | null;
  ppdId: string | null;
}

/** One page of incremental changes since a cursor. */
export interface TransactionSyncPage {
  added: GatewayTransaction[];
  modified: GatewayTransaction[];
  removedIds: string[];
  /** Save this only after the page's changes are safely stored. */
  nextCursor: string;
  hasMore: boolean;
}

/** What can be held: a fund, stock, cash position, and so on. */
export interface GatewaySecurity {
  securityId: string;
  symbol: string | null;
  name: string;
  /** The provider's type: equity, etf, mutual fund, fixed income, cash, cryptocurrency, ... */
  type: string | null;
  currency: string;
  /** Everything else the provider says about the security. All optional: not every source has it. */
  subtype?: string | null | undefined;
  isin?: string | null | undefined;
  cusip?: string | null | undefined;
  sedol?: string | null | undefined;
  figi?: string | null | undefined;
  cfiCode?: string | null | undefined;
  institutionSecurityId?: string | null | undefined;
  proxySecurityId?: string | null | undefined;
  marketIdentifierCode?: string | null | undefined;
  isCashEquivalent?: boolean | null | undefined;
  closePrice?: number | null | undefined;
  closePriceAsOf?: string | null | undefined;
  sector?: string | null | undefined;
  industry?: string | null | undefined;
  updatedAt?: string | null | undefined;
  option?:
    | {
        contractType: string | null;
        expiration: string | null;
        strike: number | null;
        underlying: string | null;
      }
    | null
    | undefined;
  fixedIncome?:
    | {
        yieldRate: number | null;
        yieldType: string | null;
        maturityDate: string | null;
        issueDate: string | null;
        faceValue: number | null;
      }
    | null
    | undefined;
  /** The complete object as the provider sent it, kept so nothing it supplies is lost. */
  raw?: unknown;
}

/** One position in an investment account. Decimal amounts as reported (dollars, not cents). */
export interface GatewayHolding {
  accountId: string;
  securityId: string;
  quantity: number;
  /** Price per unit. */
  price: number | null;
  /** Total value of the position. */
  value: number;
  /** Total cost, when the institution knows it. */
  costBasis: number | null;
  currency: string;
  /** When the figures were true, if the provider says so (an ISO date or timestamp). */
  asOf: string | null;
  /** The vested part of the position, for plans where some of it is not yet fully earned. */
  vestedQuantity?: number | null | undefined;
  vestedValue?: number | null | undefined;
  priceAsOf?: string | null | undefined;
  priceDatetime?: string | null | undefined;
  /** The complete holding as the provider sent it, including its tax lots. */
  raw?: unknown;
}

export interface HoldingsSnapshot {
  holdings: GatewayHolding[];
  securities: GatewaySecurity[];
}

export type InvestmentTransactionKind =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "contribution"
  | "withdrawal"
  | "fee"
  | "transfer"
  | "other";

/** An investment transaction. Positive amount = cash leaves the account (a purchase). */
export interface GatewayInvestmentTransaction {
  transactionId: string;
  accountId: string;
  securityId: string | null;
  date: string;
  name: string;
  kind: InvestmentTransactionKind;
  quantity: number | null;
  price: number | null;
  amount: number;
  fees: number | null;
  currency: string;
  /** The provider's finer label, such as "qualified dividend". */
  subtype?: string | null | undefined;
  datetime?: string | null | undefined;
  /** Set on a cancellation: the ID of the transaction it cancels. */
  cancelTransactionId?: string | null | undefined;
  raw?: unknown;
}

export interface InvestmentTransactionsResult {
  transactions: GatewayInvestmentTransaction[];
  securities: GatewaySecurity[];
}

export interface InstitutionBranding {
  /** A `data:` URL of the logo, or null when there is none. */
  logo: string | null;
  /** The brand color as #rrggbb, or null. */
  color: string | null;
}

export interface PlaidGateway {
  readonly environment: PlaidEnvironment;
  /** Current positions of the investment accounts of a connection. */
  getInvestmentHoldings(accessToken: string): Promise<HoldingsSnapshot>;
  /** Investment transactions between two dates (inclusive); the gateway pages through them all. */
  getInvestmentTransactions(
    accessToken: string,
    startDate: string,
    endDate: string,
  ): Promise<InvestmentTransactionsResult>;
  /** Incremental changes since `cursor` (null for the first sync). */
  syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionSyncPage>;
  createLinkToken(request: LinkTokenRequest): Promise<LinkToken>;
  exchangePublicToken(publicToken: string): Promise<ExchangedItem>;
  getItem(accessToken: string): Promise<ItemStatus>;
  getInstitutionName(institutionId: string): Promise<string | null>;
  /** The institution's logo (as a data URL) and brand color, when Plaid has them. */
  getInstitutionBranding(institutionId: string): Promise<InstitutionBranding>;
  getAccounts(accessToken: string): Promise<GatewayAccount[]>;
  removeItem(accessToken: string): Promise<void>;
  /** Called after the user completes update-mode Link, so the gateway can mark the Item healthy. */
  completeReauthentication(accessToken: string, publicToken: string | undefined): Promise<void>;
}

/** A Plaid failure reduced to what is safe to store, log, and show: never tokens or raw payloads. */
export class PlaidGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaidGatewayError";
  }
}

/** Error codes that mean the user must re-authenticate with their bank. */
export const REAUTH_ERROR_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
]);

/** Plaid error codes that mean the Item no longer exists on Plaid's side. */
export const ITEM_GONE_ERROR_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);
