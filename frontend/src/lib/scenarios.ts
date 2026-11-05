import type { ScenarioAdjustment, ScenarioComparison } from "../types/planning";
import { CADENCE_LABEL } from "./insights";
import { formatMinor } from "./money";
import { formatDay } from "./time";

/** A change in money with its sign shown ("+$50.00", "−$50.00"); zero stays plain. Pure. */
export function signedMoney(minor: number, currency: string): string {
  if (minor === 0) return formatMinor(0, currency);
  return `${minor < 0 ? "−" : "+"}${formatMinor(Math.abs(minor), currency)}`;
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

/** How a scenario moves the lowest and last days against the plan. Pure. */
export function comparisonSentence(c: ScenarioComparison, currency: string): string {
  return `With “${c.scenario.name}”: lowest ${signedMoney(c.lowestChangeMinor, currency)}, at the end ${signedMoney(c.endChangeMinor, currency)} compared with your plan.`;
}
