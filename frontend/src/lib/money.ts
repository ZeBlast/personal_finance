/** Decimal places of a currency (2 for USD, 0 for JPY). */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Reads what a person typed for an amount ("2,500", "$2,500.50", "1 200.5") into integer minor
 * units, or null if it is not a clean positive amount. Does the arithmetic on the digits as text,
 * so there is no floating-point rounding.
 */
export function parseMoneyToMinor(
  input: string,
  currency: string,
  options: { allowZero?: boolean } = {},
): number | null {
  const cleaned = input
    .trim()
    .replace(/^[^\d.-]+/, "")
    .replace(/[,\s]/g, "");
  const digits = currencyDigits(currency);
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null; // would silently lose precision
  const minor = Number(match[1]! + fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(minor) && (minor > 0 || (options.allowZero === true && minor === 0))
    ? minor
    : null;
}

/**
 * Reads a plain non-negative number ("1,200.5", "$98.1234") for things like shares and fund prices,
 * which are not whole cents. Returns null when it is not a clean number.
 */
export function parseDecimal(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/[,\s]/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A number of shares or units, without needless trailing zeros (up to 4 decimals). */
export function formatQuantity(quantity: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(quantity);
}

/** Whole dollars shortened for a chart axis: "$450", "$1.2k", "$3k". */
export function formatAxisMoney(minor: number): string {
  const dollars = Math.round(Math.abs(minor) / 100);
  const sign = minor < 0 && dollars > 0 ? "-" : "";
  return dollars >= 1000
    ? `${sign}$${(dollars / 1000).toFixed(dollars % 1000 === 0 ? 0 : 1)}k`
    : `${sign}$${dollars}`;
}

/** Formats integer minor units (cents) as currency, using the currency's own decimal places. */
export function formatMinor(minor: number | null, currency: string): string {
  if (minor === null) return "—";
  const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minor / 10 ** digits);
}
