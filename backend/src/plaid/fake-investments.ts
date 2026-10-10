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
  /** Identifiers and classification, as a real institution would supply them. */
  detail?: { isin: string; cusip: string; sector: string; industry: string; subtype: string };
  /** The share of the position that has vested (for a plan with employer money). */
  vestedShare?: number;
  /** Purchase lots, as [share of the position, price paid per unit, purchase date]. */
  lots?: Array<[number, number, string]>;
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
    detail: {
      isin: "US3141590001",
      cusip: "314159000",
      sector: "Multi-asset",
      industry: "Index fund",
      subtype: "index fund",
    },
    vestedShare: 0.8,
    lots: [
      [0.6, 78, "2024-02-01"],
      [0.4, 88, "2025-03-04"],
    ],
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
    detail: {
      isin: "US0000000AAP",
      cusip: "000000AAP",
      sector: "Technology",
      industry: "Consumer electronics",
      subtype: "common stock",
    },
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
  const d = position.detail;
  return {
    securityId: `sec-fake~${position.key}`,
    symbol: position.symbol,
    name: position.name,
    type: position.type,
    currency: "USD",
    subtype: d?.subtype ?? null,
    isin: d?.isin ?? null,
    cusip: d?.cusip ?? null,
    sector: d?.sector ?? null,
    industry: d?.industry ?? null,
    isCashEquivalent: position.type === "cash",
    // The object a real provider would have sent, in its own field names.
    raw: {
      security_id: `sec-fake~${position.key}`,
      ticker_symbol: position.symbol,
      name: position.name,
      type: position.type,
      subtype: d?.subtype ?? null,
      isin: d?.isin ?? null,
      cusip: d?.cusip ?? null,
      sector: d?.sector ?? null,
      industry: d?.industry ?? null,
      is_cash_equivalent: position.type === "cash",
      iso_currency_code: "USD",
    },
  };
}

/** Holdings of the demo brokerage account on a date. */
export function demoHoldings(accountId: string, date: string): HoldingsSnapshot {
  const holdings: GatewayHolding[] = POSITIONS.map((p) => {
    const price = priceOn(p, date);
    const value = round2(p.quantity * price);
    const vestedQuantity = p.vestedShare === undefined ? null : round2(p.quantity * p.vestedShare);
    return {
      accountId,
      securityId: `sec-fake~${p.key}`,
      quantity: p.quantity,
      price,
      value,
      costBasis: p.costBasis,
      currency: "USD",
      asOf: date,
      vestedQuantity,
      vestedValue: vestedQuantity === null ? null : round2(vestedQuantity * price),
      priceAsOf: date,
      raw: {
        security_id: `sec-fake~${p.key}`,
        institution_price: price,
        institution_price_as_of: date,
        institution_value: value,
        cost_basis: p.costBasis,
        quantity: p.quantity,
        vested_quantity: vestedQuantity,
        iso_currency_code: "USD",
        tax_lots: (p.lots ?? []).map(([share, paid, bought], i) => ({
          institution_lot_id: `LOT-${i + 1}`,
          original_purchase_datetime: `${bought}T00:00:00Z`,
          quantity: round2(p.quantity * share),
          purchase_price: paid,
          cost_basis: round2(p.quantity * share * paid),
          current_value: round2(p.quantity * share * price),
        })),
      },
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
        subtype: day === 1 ? "employee contribution" : "employer match",
        datetime: `${date}T14:30:00Z`,
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
