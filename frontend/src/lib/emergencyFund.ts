/**
 * An emergency fund target: three months of typical spending, rounded up to the nearest $100.
 * "Typical" is the median of the months given (complete months only; months with no spending are
 * left out, since they mean no data). Null when there is no month to go on. Pure.
 */
export function emergencyFundTargetMinor(monthlySpendingMinor: number[]): number | null {
  const months = monthlySpendingMinor.filter((n) => n > 0).sort((a, b) => a - b);
  if (months.length === 0) return null;
  const mid = Math.floor(months.length / 2);
  const median = months.length % 2 === 1 ? months[mid]! : (months[mid - 1]! + months[mid]!) / 2;
  return Math.ceil((median * 3) / 10_000) * 10_000;
}
