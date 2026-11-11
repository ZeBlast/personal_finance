// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Forecast } from "../../types/planning";
import {
  AnnotatedForecast,
  nearestDayIndex,
  plotDomain,
  popoverPosition,
} from "./AnnotatedForecast";

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

  it("keeps the Lowest label clear of both lines: under the lower one where there is room", () => {
    const higher = days.map((d) => ({ ...d, balanceMinor: d.balanceMinor + 30_000 }));
    const { container } = render(
      <AnnotatedForecast forecast={forecast} compare={{ label: "Raise", days: higher }} />,
    );
    const label = Number(screen.getByText(/^Lowest \$/).getAttribute("y"));
    const lastY = (d: string) => Number([...d.matchAll(/V([\d.]+)/g)].at(-1)![1]);
    const ownY = lastY(container.querySelector("path.pf-draw")!.getAttribute("d")!);
    const scenarioY = lastY(screen.getByTestId("scenario-line").getAttribute("d")!);
    expect(label).toBeGreaterThanOrEqual(Math.max(ownY, scenarioY) + 8);
  });

  it("puts the Lowest label above the line when the low is at the chart's floor", () => {
    const toZero = days.map((d, i) => ({ ...d, balanceMinor: i === 2 ? 0 : 100_000 }));
    const { container } = render(
      <AnnotatedForecast
        forecast={{ ...forecast, days: toZero, lowest: { date: "2026-11-03", balanceMinor: 0 } }}
      />,
    );
    const label = Number(screen.getByText(/^Lowest \$/).getAttribute("y"));
    const d = container.querySelector("path.pf-draw")!.getAttribute("d")!;
    expect(label).toBeLessThanOrEqual(Number([...d.matchAll(/V([\d.]+)/g)].at(-1)![1]) - 8);
  });

  it("spans down to zero only when the balance comes near it", () => {
    // Near zero, or below it: zero is on the chart.
    expect(plotDomain([100_000, 40_000])).toEqual({ top: 100_000, bottom: 0 });
    expect(plotDomain([100_000, -20_000])).toEqual({ top: 100_000, bottom: -20_000 });
    // Well above zero all along: the floor is a round figure under the lowest point.
    const high = plotDomain([3_530_000, 2_550_000]);
    expect(high.top).toBe(3_530_000);
    expect(high.bottom).toBeGreaterThan(0);
    expect(high.bottom).toBeLessThan(2_550_000);
    expect(high.bottom).toBe(2_000_000); // $20,000: a round figure under $25,500
    expect(plotDomain([])).toEqual({ top: 0, bottom: 0 });
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

describe("clicking the chart for a what-if", () => {
  it("maps a click to the nearest day and keeps it inside the plot", () => {
    // A 3-day plot from x=100, 200 wide: days sit at 100, 200 and 300.
    expect(nearestDayIndex(100, 100, 200, 3)).toBe(0);
    expect(nearestDayIndex(149, 100, 200, 3)).toBe(0);
    expect(nearestDayIndex(151, 100, 200, 3)).toBe(1);
    expect(nearestDayIndex(290, 100, 200, 3)).toBe(2);
    expect(nearestDayIndex(900, 100, 200, 3)).toBe(2);
    expect(nearestDayIndex(0, 100, 200, 3)).toBe(0);
  });

  it("keeps the pop-up inside the chart", () => {
    const box = { width: 640, height: 300 };
    const size = { width: 256, height: 290 };
    expect(popoverPosition({ x: 100, y: 50 }, box, size)).toEqual({ left: 108, top: 10 });
    expect(popoverPosition({ x: 630, y: 250 }, box, size)).toEqual({ left: 384, top: 10 });
    expect(popoverPosition({ x: 5, y: 0 }, box, size)).toEqual({ left: 13, top: 0 });
  });

  it("asks about a later day, hands back a signed one-off, and ignores today", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<AnnotatedForecast forecast={forecast} onAddWhatIf={onAdd} />);
    const chart = screen.getByRole("img");
    // The first day is today (x 56), the last is x 628 in the default 640 width.
    fireEvent.click(chart, { clientX: 56, clientY: 100 });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chart, { clientX: 628, clientY: 100 });
    expect(screen.getByRole("dialog", { name: /Add a what-if on .*Nov 3/ })).toBeTruthy();
    await user.type(screen.getByLabelText("Amount"), "150");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith({
      kind: "one_off",
      label: "What-if",
      date: "2026-11-03",
      amountMinor: -15_000,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the pop-up away on Esc", () => {
    render(<AnnotatedForecast forecast={forecast} onAddWhatIf={vi.fn()} />);
    fireEvent.click(screen.getByRole("img"), { clientX: 628, clientY: 100 });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the days of what-ifs already added", () => {
    render(<AnnotatedForecast forecast={forecast} drafted={["2026-11-02"]} />);
    expect(screen.getAllByTestId("whatif-mark")).toHaveLength(1);
  });

  it("marks two what-ifs on the same day, and fades a line that is out of date", () => {
    const lower = days.map((d) => ({ ...d, balanceMinor: d.balanceMinor - 5_000 }));
    render(
      <AnnotatedForecast
        forecast={forecast}
        compare={{ label: "x", days: lower }}
        drafted={["2026-11-02", "2026-11-02"]}
        stale
      />,
    );
    expect(screen.getAllByTestId("whatif-mark")).toHaveLength(2);
    expect(screen.getByTestId("scenario-line").getAttribute("class")).toContain("opacity-40");
  });
});
