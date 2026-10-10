/** Shapes returned by the /api/investments endpoints. Money is whole minor units (cents). */

export interface PortfolioAccount {
  id: number;
  name: string;
  officialName: string | null;
  institutionName: string | null;
  source: "plaid" | "manual" | string;
  isManual: boolean;
  /** "thrift savings plan" for a TSP account kept by hand. */
  subtype: string | null;
  color: string | null;
  connectionStatus: string | null;
  currency: string;
  valueMinor: number;
  holdingsValueMinor: number;
  holdingCount: number;
  updatedAt: string | null;
}

export interface AllocationSlice {
  assetClass: string;
  valueMinor: number;
  percent: number;
}

export interface CostBasisSummary {
  knownValueMinor: number;
  knownCostMinor: number;
  gainMinor: number;
  complete: boolean;
}

export interface PortfolioOverview {
  currency: string;
  totalValueMinor: number;
  holdingsValueMinor: number;
  accounts: PortfolioAccount[];
  allocation: AllocationSlice[];
  costBasis: CostBasisSummary | null;
}

export interface HoldingRow {
  key: string;
  securityId: number;
  accountId: number | null;
  accountName: string | null;
  symbol: string | null;
  name: string;
  assetClass: string;
  quantity: number;
  price: number | null;
  valueMinor: number;
  costBasisMinor: number | null;
  gainMinor: number | null;
  vestedQuantity: number | null;
  vestedValueMinor: number | null;
  priceAsOf: string | null;
  asOf: string;
}

export interface HistoryPoint {
  date: string;
  valueMinor: number;
}

export interface PortfolioHistory {
  total: HistoryPoint[];
  accounts: Array<{
    accountId: number;
    name: string;
    color: string | null;
    points: HistoryPoint[];
  }>;
}

export interface InvestmentTransactionRow {
  id: number;
  accountId: number;
  accountName: string | null;
  date: string;
  type: string;
  name: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amountMinor: number;
  feesMinor: number | null;
  currency: string;
  subtype: string | null;
  transactionDatetime: string | null;
  source: "plaid" | "manual" | string;
}

/** Everything stored about one security, where it is held, and the provider's own record of it. */
export interface SecurityDetail {
  security: Record<string, string | number | boolean | null>;
  raw: unknown;
  positions: Array<{
    holdingId: number;
    accountId: number;
    accountName: string;
    quantity: number;
    price: number | null;
    valueMinor: number;
    costBasisMinor: number | null;
    vestedQuantity: number | null;
    vestedValueMinor: number | null;
    asOf: string;
    priceAsOf: string | null;
    priceDatetime: string | null;
    raw: unknown;
  }>;
}

export interface InvestmentTransactionDetail extends InvestmentTransactionRow {
  cancelTransactionId: string | null;
  raw: unknown;
}

export interface FundPresets {
  assetClasses: string[];
  funds: Array<{ symbol: string; name: string; assetClass: string }>;
}
