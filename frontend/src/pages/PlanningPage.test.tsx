// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import type { Forecast, Scenario } from "../types/planning";
import { PlanningPage } from "./PlanningPage";

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.setItem("pf.forecast.compare", JSON.stringify("1"));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const day = (date: string, balanceMinor: number) => ({
  date,
  balanceMinor,
  changeMinor: 0,
  events: [],
});
const days = [day("2026-11-05", 100_000), day("2026-11-06", 90_000)];
const forecast: Forecast = {
  currency: "USD",
  today: "2026-11-05",
  startBalanceMinor: 100_000,
  accountsCounted: 1,
  days,
  lowest: { date: "2026-11-06", balanceMinor: 90_000 },
  endBalanceMinor: 90_000,
  capHoldBack: { included: false, totalMinor: 0, caps: [] },
};
const scenario: Scenario = {
  id: 1,
  name: "Rent goes up",
  adjustments: [],
  skipped: 0,
  createdAt: "",
  updatedAt: "",
};
const alt = { ...forecast, days: [day("2026-11-05", 100_000), day("2026-11-06", 85_000)] };

function routes() {
  return fakeBackend({
    "/forecast?days=60": forecast,
    "/forecast/scenarios": [scenario],
    "/forecast/scenarios/1/compare?days=60": {
      scenario,
      base: forecast,
      alt,
      lowestChangeMinor: -5_000,
      endChangeMinor: -5_000,
      unmatched: [],
    },
    "/insights/recurring": { series: [] },
    "/planned": [],
    "/goals": [],
    "PATCH /settings": undefined,
  });
}

describe("cash forecast scenarios", () => {
  it("draws the chosen scenario and removes it when switched to Nothing", async () => {
    routes();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("scenario-line")).toBeTruthy();
    expect(screen.getByText(/With “Rent goes up”: lowest \$50\.00 lower/)).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: /Compare with/ }));
    await user.click(screen.getByRole("option", { name: "Nothing" }));
    await waitFor(() => expect(screen.queryByTestId("scenario-line")).toBeNull());
  });

  it("works the scenario out again when the cap hold-back is toggled", async () => {
    const calls = routes();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("scenario-line");
    const compares = () => calls.filter((c) => c.path.includes("/compare")).length;
    const before = compares();
    await user.click(screen.getByRole("checkbox", { name: /Hold back the rest/ }));
    await waitFor(() => expect(compares()).toBe(before + 1));
  });
});
