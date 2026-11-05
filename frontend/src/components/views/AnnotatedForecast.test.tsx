// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Forecast } from "../../types/planning";
import { AnnotatedForecast } from "./AnnotatedForecast";

afterEach(cleanup);

const days = ["2026-11-01", "2026-11-02", "2026-11-03"].map((date, i) => ({
  date,
  balanceMinor: 100_000 - i * 10_000,
  changeMinor: i === 0 ? 0 : -10_000,
  events: [],
}));
const forecast: Forecast = {
  currency: "USD",
  today: "2026-11-01",
  startBalanceMinor: 100_000,
  accountsCounted: 1,
  days,
  lowest: { date: "2026-11-03", balanceMinor: 80_000 },
  endBalanceMinor: 80_000,
  capHoldBack: { included: false, totalMinor: 0, caps: [] },
};

describe("annotated forecast", () => {
  it("draws no scenario line by default", () => {
    render(<AnnotatedForecast forecast={forecast} />);
    expect(screen.queryByTestId("scenario-line")).toBeNull();
  });

  it("keeps the Lowest label above a scenario line that runs higher", () => {
    const higher = days.map((d) => ({ ...d, balanceMinor: d.balanceMinor + 30_000 }));
    render(<AnnotatedForecast forecast={forecast} compare={{ label: "Raise", days: higher }} />);
    const label = screen.getByText(/^Lowest \$/);
    const path = screen.getByTestId("scenario-line").getAttribute("d")!;
    const scenarioY = Number([...path.matchAll(/V([\d.]+)/g)].at(-1)![1]);
    expect(Number(label.getAttribute("y"))).toBeLessThanOrEqual(scenarioY - 8);
  });

  it("marks only the days something real happens, not the daily cap hold-back", () => {
    const held = days.map((d, i) => ({
      ...d,
      events:
        i === 1
          ? [
              {
                label: "Spending caps (rest of November)",
                amountMinor: -5_000,
                source: "cap_holdback" as const,
              },
            ]
          : i === 2
            ? [{ label: "Rent", amountMinor: -10_000, source: "recurring" as const }]
            : [],
    }));
    render(<AnnotatedForecast forecast={{ ...forecast, days: held }} />);
    expect(screen.getAllByTestId("event-mark")).toHaveLength(1);
  });

  it("draws a scenario line and names it in the legend when comparing", () => {
    const lower = days.map((d) => ({ ...d, balanceMinor: d.balanceMinor - 5_000 }));
    render(
      <AnnotatedForecast forecast={forecast} compare={{ label: "Rent goes up", days: lower }} />,
    );
    expect(screen.getByTestId("scenario-line")).toBeTruthy();
    expect(screen.getByText(/With Rent goes up/)).toBeTruthy();
  });
});
