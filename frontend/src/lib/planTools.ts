import type { SafetyNet } from "../types/planTools";
import { formatMinor } from "./money";

/** Words for the planning tools' figures. Pure. */

const monthsWord = (n: number): string => `${n} ${n === 1 ? "month" : "months"}`;

/** The safety net in words: the headline, how it is worked out, and whether it meets the target. Pure. */
export function runwayText(
  s: SafetyNet,
  targetMonths: number,
): { headline: string; detail: string; tone: "good" | "warn" | "none" } {
  if (s.months === null) {
    return {
      headline: "No spending yet",
      detail: "Once a month of spending is in, this shows how long your cash would last.",
      tone: "none",
    };
  }
  const money = (n: number) => formatMinor(n, s.currency);
  const what = s.basis === "essential" ? "essentials" : "all spending";
  let detail = `${money(s.monthlyMinor)} a month of ${what}, from ${money(s.freeCashMinor)} after goals.`;
  if (s.basis === "all") detail += " Choose your essentials for a truer figure.";
  return {
    headline: monthsWord(s.months),
    detail,
    tone: s.months >= targetMonths ? "good" : "warn",
  };
}
