/** Currencies that have no minor unit (1 yen is the smallest amount). */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
/** Currencies with three decimal places. */
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/**
 * Converts a decimal amount from a provider (such as 12.34 dollars) to integer minor units
 * (1234 cents). Returns null when the provider gave no amount. Rounds to the nearest unit so
 * floating-point noise like 0.1 + 0.2 never reaches the database.
 */
export function toMinorUnits(amount: number | null | undefined, currency: string): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  const factor = 10 ** minorUnitDigits(currency);
  // Math.round rounds halves toward +infinity; do it on the absolute value for symmetric results.
  const scaled = Math.round(Math.abs(amount) * factor + Number.EPSILON * factor);
  return amount < 0 ? -scaled : scaled;
}
