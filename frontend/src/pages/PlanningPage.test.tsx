// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import type { Forecast, Scenario } from "../types/planning";
import { CardBillsPage, PlanningPage } from "./PlanningPage";

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
    expect(screen.getByText(/^With your what-ifs: lowest/)).toBeTruthy();
    // The tile leads with the what-ifs' own figure, and the list says what is being compared.
    expect(screen.getByText(/ with your what-ifs \(\$50\.00 lower\)$/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Compare with/ }).textContent).toContain(
      "Your what-ifs (not saved)",
    );
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
    await screen.findByText(/^With Rent goes up \+ 1 what-if: lowest/);
    expect(screen.getByText(/ with Rent goes up \+ 1 what-if \(\$50\.00 lower\)$/)).toBeTruthy();
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

  it("stops adding when the scenario's changes plus the draft would pass the limit", async () => {
    const full: Scenario = { ...scenario, adjustments: Array.from({ length: 50 }, () => fee) };
    const calls = fakeBackend({
      "/forecast?days=60": forecast,
      "/forecast/scenarios": [full],
      "/forecast/scenarios/1/compare?days=60": {
        scenario: full,
        base: forecast,
        alt,
        lowestChangeMinor: 0,
        endChangeMinor: 0,
        unmatched: [],
      },
      "/insights/recurring": { series: [] },
      "/planned": [],
      "/goals": [],
    });
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    const add = await screen.findByRole("button", { name: "Add a what-if..." });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You can add up to 0 what-ifs on top of this scenario/)).toBeTruthy();
    fireEvent.click(screen.getByRole("img"), { clientX: 600, clientY: 100 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.path.includes("preview"))).toBe(false);
  });

  it("asks for a smaller amount instead of sending one the backend would refuse", async () => {
    window.localStorage.setItem("pf.forecast.compare", JSON.stringify(""));
    const calls = fakeBackend({ "/forecast?days=60": forecast, "/forecast/scenarios": [] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PlanningPage />
      </MemoryRouter>,
    );
    await addThroughDialog(user, "2000000000");
    expect(screen.getByText(/too large/)).toBeTruthy();
    expect(calls.some((c) => c.path.includes("preview"))).toBe(false);
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

describe("card bills", () => {
  it("offers the days already set for the card's statements instead of saying none are set", async () => {
    const calls = fakeBackend({
      "/bills": [
        {
          accountId: 4,
          name: "Visa",
          institutionName: null,
          color: null,
          currency: "USD",
          currentBalanceMinor: 12_000,
          settings: null,
          statementDays: { closingDay: 15, dueDay: 10 },
          statement: null,
          next: null,
        },
      ],
      "PUT /accounts/4/bill": null,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CardBillsPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Statement closes on day 15, payment due on day 10\. Not counted/),
    ).toBeTruthy();
    expect(screen.queryByText(/Bill dates not set/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Count this bill in the forecast" }));
    expect((screen.getByLabelText("Statement closes on day") as HTMLInputElement).value).toBe("15");
    expect((screen.getByLabelText("Payment due on day") as HTMLInputElement).value).toBe("10");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        closingDay: 15,
        dueDay: 10,
        minimumMinor: null,
        autopay: false,
      }),
    );
  });
});
