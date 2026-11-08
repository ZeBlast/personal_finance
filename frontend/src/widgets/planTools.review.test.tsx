// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { today } from "../lib/period";
import { MonthPlanPage } from "../pages/MonthPlanPage";
import { fakeBackend } from "../test/fakeBackend";
import afford from "./AffordWidget";
import safetyNet from "./SafetyNetWidget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const size = { w: 4, h: 6 };

describe("the planning tools ask for the computer's own day", () => {
  it("can I afford it", async () => {
    const calls = fakeBackend({
      "/settings": { currency: "USD", essentialCategoryIds: [] },
    });
    const Afford = afford.Component;
    render(<Afford config={{ buffer: 0 }} instanceId={1} size={size} />);
    await userEvent.type(screen.getByLabelText("How much"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/afford?"))).toBe(true));
    const asked = calls.find((c) => c.path.startsWith("/afford?"))!;
    expect(new URLSearchParams(asked.path.split("?")[1]).get("today")).toBe(today());
  });

  it("the month plan", async () => {
    const calls = fakeBackend({});
    render(
      <MemoryRouter>
        <MonthPlanPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/month-plan?"))).toBe(true));
    const asked = calls.find((c) => c.path.startsWith("/month-plan?"))!;
    expect(new URLSearchParams(asked.path.split("?")[1]).get("today")).toBe(today());
  });
});

describe("the safety net", () => {
  it("does not offer to change essentials before it knows the ones chosen", async () => {
    fakeBackend({
      [`/safety-net?today=${today()}`]: {
        currency: "USD",
        cashMinor: 0,
        reservedMinor: 0,
        freeCashMinor: 0,
        monthlyMinor: 0,
        basis: "all",
        monthsAveraged: 1,
        months: null,
        essentials: [],
      },
    });
    const Net = safetyNet.Component;
    render(<Net config={{ target: 6 }} instanceId={1} size={size} />);
    const button = await screen.findByRole("button", { name: "Choose essentials" });
    expect(button).toHaveProperty("disabled", true);
  });
});
