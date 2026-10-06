/** Shapes returned by the /api/investments endpoints. Money is whole minor units (cents). */

export interface PortfolioAccount {
  id: number;
  name: string;
  officialName: string | null;
  institutionName: string | null;
  source: "plaid" | "manual" | string;
  isManual: boolean;
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
  source: "plaid" | "manual" | string;
}

export interface FundPresets {
  assetClasses: string[];
  funds: Array<{ symbol: string; name: string; assetClass: string }>;
}
