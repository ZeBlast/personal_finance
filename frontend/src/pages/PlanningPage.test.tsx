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

describe("cash forecast what-ifs from the chart", () => {
  const fee = {
    kind: "one_off" as const,
    label: "Fee",
    date: "2026-11-06",
    amountMinor: -1_000,
  };
  const draftEntry = { ...fee, label: "What-if", amountMinor: -15_000 };
  const withFee: Scenario = { ...scenario, adjustments: [fee] };
  const previewAnswer = () => ({
    scenario: { ...scenario, id: 0, name: "Your what-ifs", adjustments: [] },
    base: forecast,
    alt,
    lowestChangeMinor: -5_000,
    endChangeMinor: -5_000,
    unmatched: [],
  });

  async function addThroughDialog(user: ReturnType<typeof userEvent.setup>, amount: string) {
    await user.click(await screen.findByRole("button", { name: "Add a what-if..." }));
    await user.type(screen.getByLabelText("Amount"), amount);
    await user.click(screen.getByRole("button", { name: "Add" }));
  }

  it("adds a chip and previews the signed amount, then goes back to the base view when it is removed", async () => {
    window.localStorage.setItem("pf.forecast.compare", JSON.stringify(""));
    const calls = fakeBackend({
      "/forecast?days=60": forecast,
      "/forecast/scenarios": [],
      "POST /forecast/scenarios/preview": previewAnswer,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    await addThroughDialog(user, "150");
    expect(await screen.findByText(/^−\$150\.00 · What-if · /)).toBeTruthy();
    expect(await screen.findByTestId("scenario-line")).toBeTruthy();
    expect(screen.getAllByTestId("whatif-mark")).toHaveLength(1);
    expect(screen.getByText(/With “your what-ifs”/)).toBeTruthy();
    const previews = () => calls.filter((c) => c.path === "/forecast/scenarios/preview");
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.body).toEqual({ adjustments: [draftEntry], days: 60 });

    await user.click(screen.getByRole("button", { name: /^Remove −\$150\.00/ }));
    await waitFor(() => expect(screen.queryByTestId("scenario-line")).toBeNull());
    expect(screen.queryByTestId("whatif-mark")).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    expect(previews()).toHaveLength(1);
  });

  it("saves the selected scenario's changes plus the draft as a new scenario and selects it", async () => {
    const saved: Scenario = { ...scenario, id: 7, name: "Trip", adjustments: [fee, draftEntry] };
    let list: Scenario[] = [withFee];
    const calls = fakeBackend({
      "/forecast?days=60": forecast,
      "/forecast/scenarios": () => list,
      "POST /forecast/scenarios": () => {
        list = [withFee, saved];
        return saved;
      },
      "POST /forecast/scenarios/preview": previewAnswer,
      "/forecast/scenarios/1/compare?days=60": previewAnswer(),
      "/forecast/scenarios/7/compare?days=60": { ...previewAnswer(), scenario: saved },
      "/insights/recurring": { series: [] },
      "/planned": [],
      "/goals": [],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    await addThroughDialog(user, "150");
    await screen.findByText(/^−\$150\.00 · What-if · /);
    await screen.findByText(/With “Rent goes up \+ 1 what-if”/);
    const previews = calls.filter((c) => c.path === "/forecast/scenarios/preview");
    expect(previews.at(-1)!.body).toEqual({ adjustments: [fee, draftEntry], days: 60 });

    await user.click(screen.getByRole("button", { name: "Save as scenario..." }));
    await user.type(screen.getByLabelText("Name"), "Trip");
    await user.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /Compare with/ }).textContent).toContain("Trip"),
    );
    const post = calls.find((c) => c.method === "POST" && c.path === "/forecast/scenarios");
    expect(post?.body).toEqual({ name: "Trip", adjustments: [fee, draftEntry] });
    expect(screen.queryByText(/^−\$150\.00 · What-if · /)).toBeNull();
    expect(window.localStorage.getItem("pf.forecast.compare")).toBe(JSON.stringify("7"));
  });

  it("keeps the draft and shows an error when the preview fails", async () => {
    window.localStorage.setItem("pf.forecast.compare", JSON.stringify(""));
    fakeBackend({
      "/forecast?days=60": forecast,
      "/forecast/scenarios": [],
      "POST /forecast/scenarios/preview": () => {
        throw new Error("boom");
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    await addThroughDialog(user, "20");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/^−\$20\.00 · What-if · /)).toBeTruthy();
  });
});
