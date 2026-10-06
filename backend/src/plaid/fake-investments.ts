import type {
  GatewayHolding,
  GatewayInvestmentTransaction,
  GatewaySecurity,
  HoldingsSnapshot,
  InvestmentTransactionsResult,
} from "./gateway.js";

/**
 * Demo investment data for the built-in gateway: a small portfolio whose prices drift smoothly
 * with the date (so a value-over-time chart has something to show, and the same date always gives
 * the same numbers), and a regular pattern of contributions, purchases, and dividends.
 */

interface DemoPosition {
  key: string;
  symbol: string | null;
  name: string;
  type: string;
  quantity: number;
  basePrice: number;
  /** Total cost, or null to leave cost basis unknown (as many institutions do). */
  costBasis: number | null;
}

const POSITIONS: DemoPosition[] = [
  {
    key: "total-market",
    symbol: "FTMIX",
    name: "Fake Total Market Index Fund",
    type: "mutual fund",
    quantity: 120.5,
    basePrice: 100,
    costBasis: 9800,
  },
  {
    key: "bond-index",
    symbol: "FBNDX",
    name: "Fake Bond Index Fund",
    type: "mutual fund",
    quantity: 300,
    basePrice: 10.5,
    costBasis: 3300,
  },
  {
    key: "apple",
    symbol: "FAAPL",
    name: "Fake Apple Co.",
    type: "equity",
    quantity: 15,
    basePrice: 190,
    costBasis: null,
  },
  {
    key: "cash",
    symbol: null,
    name: "U.S. Dollar",
    type: "cash",
    quantity: 1500,
    basePrice: 1,
    costBasis: 1500,
  },
];

const DAY_MS = 86_400_000;

/** Days since 2020-01-01, so prices depend only on the calendar date. */
function dayNumber(date: string): number {
  return Math.floor(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse("2020-01-01T00:00:00Z")) / DAY_MS,
  );
}

function priceOn(position: DemoPosition, date: string): number {
  if (position.type === "cash") return 1;
  const wave = Math.sin(dayNumber(date) / 9) * 0.03 + Math.sin(dayNumber(date) / 31) * 0.05;
  return Math.round(position.basePrice * (1 + wave) * 10_000) / 10_000;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function securityOf(position: DemoPosition): GatewaySecurity {
  return {
    securityId: `sec-fake~${position.key}`,
    symbol: position.symbol,
    name: position.name,
    type: position.type,
    currency: "USD",
  };
}

/** Holdings of the demo brokerage account on a date. */
export function demoHoldings(accountId: string, date: string): HoldingsSnapshot {
  const holdings: GatewayHolding[] = POSITIONS.map((p) => {
    const price = priceOn(p, date);
    return {
      accountId,
      securityId: `sec-fake~${p.key}`,
      quantity: p.quantity,
      price,
      value: round2(p.quantity * price),
      costBasis: p.costBasis,
      currency: "USD",
      asOf: date,
    };
  });
  return { holdings, securities: POSITIONS.map(securityOf) };
}

/** What the demo account is worth on a date: the sum of its positions. */
export function demoAccountValue(date: string): number {
  return round2(demoHoldings("x", date).holdings.reduce((sum, h) => sum + h.value, 0));
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Demo activity: a contribution on the 1st and 15th, a purchase of the total-market fund on the
 * 16th, and a dividend on the 20th of every third month.
 */
export function demoInvestmentTransactions(
  accountId: string,
  startDate: string,
  endDate: string,
): InvestmentTransactionsResult {
  const transactions: GatewayInvestmentTransaction[] = [];
  const market = POSITIONS[0]!;
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    const day = Number(date.slice(8));
    const month = Number(date.slice(5, 7));
    const base = { accountId, date, currency: "USD", fees: null };
    if (day === 1 || day === 15) {
      transactions.push({
        ...base,
        transactionId: `invtx-fake~${accountId}~${date}~contribution`,
        securityId: null,
        name: "Payroll contribution",
        kind: "contribution",
        quantity: null,
        price: null,
        amount: -400,
      });
    }
    if (day === 16) {
      const price = priceOn(market, date);
      transactions.push({
        ...base,
        transactionId: `invtx-fake~${accountId}~${date}~buy`,
        securityId: `sec-fake~${market.key}`,
        name: `Buy ${market.name}`,
        kind: "buy",
        quantity: 4,
        price,
        amount: round2(4 * price),
      });
    }
    if (day === 20 && month % 3 === 0) {
      transactions.push({
        ...base,
        transactionId: `invtx-fake~${accountId}~${date}~dividend`,
        securityId: `sec-fake~${POSITIONS[1]!.key}`,
        name: `Dividend ${POSITIONS[1]!.name}`,
        kind: "dividend",
        quantity: null,
        price: null,
        amount: -37.5,
      });
    }
  }
  return { transactions, securities: POSITIONS.map(securityOf) };
}
