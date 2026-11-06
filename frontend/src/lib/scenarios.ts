import type { ScenarioAdjustment, ScenarioComparison } from "../types/planning";
import { CADENCE_LABEL } from "./insights";
import { formatMinor } from "./money";
import { formatDay } from "./time";

/** A change in money with its sign shown ("+$50.00", "−$50.00"); zero stays plain. Pure. */
export function signedMoney(minor: number, currency: string): string {
  if (minor === 0) return formatMinor(0, currency);
  return `${minor < 0 ? "−" : "+"}${formatMinor(Math.abs(minor), currency)}`;
}

/**
 * The detected payments the forecast actually carries, so a change to one can show up: those with
 * no expected transaction of the same merchant (that one is counted instead), paid from a bank
 * account or a card whose bill dates are set. Pure.
 */
export function forecastedSeries<S extends { merchant: string; accountNames: string[] }>(
  series: S[],
  plannedMerchants: string[],
  accounts: Array<{ name: string; type: string }>,
  bills: Array<{ name: string; statement: unknown }>,
): S[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const planned = new Set(plannedMerchants.map(norm));
  const banks = new Set(accounts.filter((a) => a.type === "depository").map((a) => a.name));
  const billed = new Set(bills.filter((b) => b.statement !== null).map((b) => b.name));
  return series.filter(
    (s) =>
      !planned.has(norm(s.merchant)) &&
      s.accountNames.some((name) => banks.has(name) || billed.has(name)),
  );
}

/** What a scenario change does, in one plain line. Pure. */
export function describeAdjustment(
  a: ScenarioAdjustment,
  currency: string,
  names: {
    series: Map<string, string>;
    planned: Map<number, string>;
    goals: Map<number, string>;
  },
): string {
  switch (a.kind) {
    case "one_off":
      return `${a.label}: ${signedMoney(a.amountMinor, currency)} on ${formatDay(a.date)}`;
    case "recurring": {
      const until = a.endDate ? `, until ${formatDay(a.endDate)}` : "";
      return `${a.label}: ${signedMoney(a.amountMinor, currency)} ${CADENCE_LABEL[a.cadence].toLowerCase()} from ${formatDay(a.startDate)}${until}`;
    }
    case "change_series": {
      const name =
        ("seriesKey" in a.target
          ? names.series.get(a.target.seriesKey)
          : names.planned.get(a.target.plannedId)) ?? "a regular payment";
      return a.amountMinor === null
        ? `Stop ${name} from ${formatDay(a.fromDate)}`
        : `Change ${name} to ${formatMinor(a.amountMinor, currency)} from ${formatDay(a.fromDate)}`;
    }
    case "goal": {
      const name = names.goals.get(a.goalId) ?? "a goal";
      return a.forecast === null
        ? `${name}: stop counting its monthly contribution`
        : `${name}: set aside ${formatMinor(a.forecast.monthlyMinor, currency)} a month, on day ${a.forecast.day}`;
    }
  }
}

/** The most what-ifs a draft holds before it must be saved or trimmed. */
export const MAX_WHAT_IFS = 20;

/** What the dashed line is called when it includes unsaved what-ifs. Pure. */
export function draftName(scenarioName: string | null, count: number): string {
  if (scenarioName === null) return "your what-ifs";
  return `${scenarioName} + ${count} what-if${count === 1 ? "" : "s"}`;
}

/** How far a scenario's figure is from the plan's: "$10.00 lower", "$10.00 higher" or "the same". Pure. */
export function differenceText(minor: number, currency: string): string {
  if (minor === 0) return "the same";
  return `${formatMinor(Math.abs(minor), currency)} ${minor < 0 ? "lower" : "higher"}`;
}

/** What sits under a tile: "$10.00 lower with the scenario" (not a balance, so no sign). Pure. */
export function tileChangeText(minor: number, currency: string): string {
  if (minor === 0) return "Same with the scenario";
  return `${differenceText(minor, currency)} with the scenario`;
}

/** How a scenario moves the lowest and last days against the plan. Pure. */
export function comparisonSentence(c: ScenarioComparison, currency: string): string {
  const { lowestChangeMinor: low, endChangeMinor: end } = c;
  if (low === 0 && end === 0) {
    return `With “${c.scenario.name}”: the lowest and the end balance are the same as your plan.`;
  }
  const figures = `lowest ${differenceText(low, currency)}, end ${differenceText(end, currency)}`;
  return `With “${c.scenario.name}”: ${figures}${low !== 0 && end !== 0 ? " than" : " compared with"} your plan.`;
}

/** The note for a change that did nothing in the forecast: ended before today, or matched nothing. Pure. */
export function unmatchedNote(a: ScenarioAdjustment, today: string, days: number): string {
  const before =
    (a.kind === "one_off" && a.date <= today) ||
    (a.kind === "recurring" && a.endDate !== null && a.endDate <= today);
  return before
    ? "This change is before today, so it doesn't affect the forecast."
    : `This change doesn't match anything in the next ${days} days.`;
}
