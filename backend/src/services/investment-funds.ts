export const ASSET_CLASSES = ["Stocks", "Bonds", "Cash", "Funds", "Crypto", "Other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export function isAssetClass(value: unknown): value is AssetClass {
  return typeof value === "string" && (ASSET_CLASSES as readonly string[]).includes(value);
}

/** Groups a provider's security type into the classes used by allocation charts. */
export function assetClassFor(type: string | null | undefined): AssetClass {
  switch ((type ?? "").toLowerCase()) {
    case "equity":
      return "Stocks";
    case "etf":
    case "mutual fund":
      return "Funds";
    case "fixed income":
      return "Bonds";
    case "cash":
      return "Cash";
    case "cryptocurrency":
      return "Crypto";
    default:
      return "Other";
  }
}

export interface KnownFund {
  /** Used as the symbol. Prefixed `TSP-` because single letters are real stock tickers. */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Short code the fund goes by, e.g. `G` or `L2050`. */
  code: string;
}

/**
 * The Thrift Savings Plan funds, offered as presets because Plaid is not expected to connect to
 * the TSP. The L (lifecycle) funds mix the others, so they count as "Funds". Anything not listed
 * (a newer L fund, say) can still be entered as a custom fund.
 */
const fund = (code: string, name: string, assetClass: AssetClass): KnownFund => ({
  code,
  name,
  assetClass,
  symbol: `TSP-${code}`,
});

export const TSP_FUNDS: KnownFund[] = [
  fund("G", "TSP G Fund (Government Securities)", "Bonds"),
  fund("F", "TSP F Fund (Fixed Income Index)", "Bonds"),
  fund("C", "TSP C Fund (Common Stock Index)", "Stocks"),
  fund("S", "TSP S Fund (Small Cap Stock Index)", "Stocks"),
  fund("I", "TSP I Fund (International Stock Index)", "Stocks"),
  fund("LINCOME", "TSP L Income Fund", "Funds"),
  ...[2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070, 2075].map((year) =>
    fund(`L${year}`, `TSP L ${year} Fund`, "Funds"),
  ),
];

const normalize = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Names a CSV or form might use for a fund: `TSP-G`, `G Fund`, `TSP G Fund`, `L 2050`, ... */
function aliasesOf(known: KnownFund): string[] {
  const code = known.code;
  const aliases = [`TSP${code}`, `${code}FUND`, `TSP${code}FUND`];
  if (code.length > 1) aliases.push(code); // never a bare "C" or "S": those are real tickers
  return aliases;
}

/** Finds a preset fund from what the user typed, or undefined. */
export function findKnownFund(input: string | null | undefined): KnownFund | undefined {
  if (!input) return undefined;
  const wanted = normalize(input);
  if (!wanted) return undefined;
  return TSP_FUNDS.find(
    (known) => aliasesOf(known).includes(wanted) || normalize(known.name) === wanted,
  );
}
