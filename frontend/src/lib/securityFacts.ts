import type { SecurityDetail } from "../types/investments";

export interface FactGroup {
  title: string;
  rows: Array<[label: string, value: string]>;
}

type Security = SecurityDetail["security"];

const has = (v: unknown): v is string | number | boolean =>
  v !== null && v !== undefined && v !== "";

const text = (v: unknown): string => String(v);
const yesNo = (v: unknown): string => (v ? "Yes" : "No");
const price = (v: unknown): string =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(Number(v));
const percent = (v: unknown): string => `${Number(v)}%`;

/** Which stored field goes where, under what label, and how to show it. */
const GROUPS: Array<{
  title: string;
  fields: Array<[field: string, label: string, show?: (v: unknown) => string]>;
}> = [
  {
    title: "Identifiers",
    fields: [
      ["symbol", "Symbol"],
      ["isin", "ISIN"],
      ["cusip", "CUSIP"],
      ["sedol", "SEDOL"],
      ["figi", "FIGI"],
      ["cfiCode", "CFI code"],
      ["marketIdentifierCode", "Market (MIC)"],
      ["institutionSecurityId", "Institution's own ID"],
      ["proxySecurityId", "Proxy security"],
    ],
  },
  {
    title: "Classification",
    fields: [
      ["securityType", "Type"],
      ["subtype", "Subtype"],
      ["assetClass", "Asset class"],
      ["sector", "Sector"],
      ["industry", "Industry"],
      ["isCashEquivalent", "Cash equivalent", yesNo],
    ],
  },
  {
    title: "Pricing",
    fields: [
      ["closePrice", "Closing price", price],
      ["closePriceAsOf", "Price date"],
      ["providerUpdatedAt", "Provider updated"],
    ],
  },
  {
    title: "Option contract",
    fields: [
      ["optionContractType", "Contract"],
      ["optionExpiration", "Expires"],
      ["optionStrike", "Strike price", price],
      ["optionUnderlying", "Underlying"],
    ],
  },
  {
    title: "Fixed income",
    fields: [
      ["fixedYieldRate", "Yield", percent],
      ["fixedYieldType", "Yield type"],
      ["fixedIssueDate", "Issued"],
      ["fixedMaturityDate", "Matures"],
      ["fixedFaceValue", "Face value", price],
    ],
  },
];

/**
 * The stored facts about a security, grouped and labelled, leaving out anything unknown. A group
 * with nothing to show is left out too, so a plain fund shows a short list and an option shows
 * its contract.
 */
export function securityFacts(security: Security): FactGroup[] {
  const groups: FactGroup[] = [];
  for (const group of GROUPS) {
    const rows: Array<[string, string]> = [];
    for (const [field, label, show] of group.fields) {
      const value = security[field];
      if (has(value)) rows.push([label, (show ?? text)(value)]);
    }
    if (rows.length > 0) groups.push({ title: group.title, rows });
  }
  groups.push({
    title: "Source",
    rows: [
      [
        "Where it came from",
        security["isManual"] ? "Entered by hand" : "Reported by your institution through Plaid",
      ],
      ...(has(security["plaidSecurityId"])
        ? ([["Plaid security ID", text(security["plaidSecurityId"])]] as Array<[string, string]>)
        : []),
    ],
  });
  return groups;
}

export interface TaxLot {
  id: string | null;
  purchased: string | null;
  quantity: number | null;
  purchasePrice: number | null;
  costBasis: number | null;
  currentValue: number | null;
}

/** The tax lots in a provider's holding record, if it had any. */
export function taxLotsOf(raw: unknown): TaxLot[] {
  const lots = (raw as { tax_lots?: unknown } | null)?.tax_lots;
  if (!Array.isArray(lots)) return [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return lots.map((lot: Record<string, unknown>) => ({
    id: str(lot["institution_lot_id"]),
    purchased: str(lot["original_purchase_datetime"])?.slice(0, 10) ?? null,
    quantity: num(lot["quantity"]),
    purchasePrice: num(lot["purchase_price"]),
    costBasis: num(lot["cost_basis"]),
    currentValue: num(lot["current_value"]),
  }));
}
