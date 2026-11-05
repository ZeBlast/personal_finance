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

  it("draws a scenario line and names it in the legend when comparing", () => {
    const lower = days.map((d) => ({ ...d, balanceMinor: d.balanceMinor - 5_000 }));
    render(
      <AnnotatedForecast forecast={forecast} compare={{ label: "Rent goes up", days: lower }} />,
    );
    expect(screen.getByTestId("scenario-line")).toBeTruthy();
    expect(screen.getByText(/With Rent goes up/)).toBeTruthy();
  });
});
