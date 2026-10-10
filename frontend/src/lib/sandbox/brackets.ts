/** Tax brackets as [the income where the rate starts, the rate (0-1)], lowest first. */
export type Brackets = Array<[number, number]>;

/** Tax by brackets: each slice of income taxed at its own rate. */
export function bracketTax(taxable: number, brackets: Brackets): { tax: number; marginal: number } {
  let tax = 0;
  let marginal = 0;
  brackets.forEach(([floor, rate], i) => {
    const top = brackets[i + 1]?.[0] ?? Infinity;
    if (taxable > floor) {
      tax += (Math.min(taxable, top) - floor) * rate;
      marginal = rate;
    }
  });
  return { tax, marginal };
}

/**
 * Reads brackets the user typed, as "from percent" pairs separated by commas or new lines:
 * "0 2, 3000 3, 5000 5, 17000 5.75" means 2% from $0, 3% from $3,000, and so on. Dollar signs,
 * thousands commas inside numbers (3,000), and % signs are allowed. Returns null when it cannot be read.
 */
export function parseBrackets(text: string): Brackets | null {
  // Take "from rate" pairs: a number (which may contain thousands commas) then a percentage.
  const pairs = [
    ...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:[:=\s]|->)\s*(\d+(?:\.\d+)?)\s*%?/g),
  ];
  if (pairs.length === 0) return null;
  const brackets: Brackets = pairs.map((m) => [
    Number(m[1]!.replace(/,/g, "")),
    Number(m[2]) / 100,
  ]);
  if (brackets.some(([f, r]) => !Number.isFinite(f) || !Number.isFinite(r) || r < 0 || r > 1)) {
    return null;
  }
  brackets.sort((a, b) => a[0] - b[0]);
  return brackets;
}

/** Brackets as the user would type them back. */
export function formatBrackets(brackets: Brackets): string {
  return brackets.map(([f, r]) => `${f} ${Math.round(r * 100_000) / 1000}`).join(", ");
}
