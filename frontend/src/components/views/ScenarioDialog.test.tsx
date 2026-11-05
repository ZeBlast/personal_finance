// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { RecurringSeries } from "../../types/insights";
import type { Scenario } from "../../types/planning";
import { ScenarioDialog, type ScenarioPickers } from "./ScenarioDialog";

const paycheck = {
  key: "pay|acme",
  merchant: "Acme payroll",
  direction: "in",
  typicalAmountMinor: 250_000,
} as RecurringSeries;

function pickers(series: RecurringSeries[] = []): ScenarioPickers {
  return {
    series,
    planned: [],
    goals: [],
    names: {
      series: new Map(series.map((x) => [x.key, x.merchant])),
      planned: new Map(),
      goals: new Map(),
    },
  };
}

function open(props: Partial<Parameters<typeof ScenarioDialog>[0]> = {}) {
  return render(
    <ScenarioDialog
      scenarios={[]}
      pickers={pickers()}
      currency="USD"
      today="2026-11-05"
      days={60}
      unmatched={null}
      onChanged={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scenario dialog", () => {
  it("saves a new scenario with a one-off change and writes nothing else", async () => {
    const saved = { id: 4, name: "Car", adjustments: [], skipped: 0, createdAt: "", updatedAt: "" };
    const calls = fakeBackend({
      "POST /forecast/scenarios": saved,
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    open({ onChanged });
    await user.click(screen.getByRole("button", { name: "New scenario" }));
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0]!, "Car");
    await user.type(names[1]!, "Repair");
    await user.type(screen.getByLabelText("Amount"), "500");
    await user.click(screen.getByRole("button", { name: "Add this change" }));
    expect(screen.getByText(/Repair: −\$500\.00 on/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(4));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      name: "Car",
      adjustments: [{ kind: "one_off", label: "Repair", amountMinor: -50_000 }],
    });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });

  it("offers a paycheck series and can stop it", async () => {
    const calls = fakeBackend({
      "POST /forecast/scenarios": { id: 5, name: "x", adjustments: [], skipped: 0 },
    });
    const user = userEvent.setup();
    open({ pickers: pickers([paycheck]) });
    await user.click(screen.getByRole("button", { name: "New scenario" }));
    await user.type(screen.getAllByLabelText("Name")[0]!, "No pay");
    await user.click(screen.getByRole("combobox", { name: "What kind of change" }));
    await user.click(screen.getByRole("option", { name: "Change or stop a regular payment" }));
    await user.click(screen.getByRole("combobox", { name: "Which payment" }));
    await user.click(
      screen.getByRole("option", { name: /Acme payroll, coming in, usually \$2,500\.00/ }),
    );
    await user.click(screen.getByRole("button", { name: "Add this change" }));
    expect(screen.getByText(/Stop Acme payroll from/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      adjustments: [
        { kind: "change_series", target: { seriesKey: "pay|acme" }, amountMinor: null },
      ],
    });
  });

  it("edits an existing scenario with a PUT to its own id", async () => {
    const existing: Scenario = {
      id: 9,
      name: "Rent up",
      adjustments: [{ kind: "one_off", label: "Fee", date: "2026-11-10", amountMinor: -1_000 }],
      skipped: 0,
      createdAt: "",
      updatedAt: "",
    };
    const calls = fakeBackend({ "PUT /forecast/scenarios/9": existing });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    open({ scenarios: [existing], onChanged });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getAllByLabelText("Name")[0]!;
    await user.clear(name);
    await user.type(name, "Rent up a lot");
    await user.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(9));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ name: "Rent up a lot", adjustments: existing.adjustments });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });

  it("keeps a 'matches nothing' note on its own change when another row is removed", async () => {
    const first = { kind: "one_off", label: "First", date: "2026-11-10", amountMinor: -1_000 };
    const second = { kind: "one_off", label: "Second", date: "2026-11-11", amountMinor: -2_000 };
    const existing: Scenario = {
      id: 9,
      name: "Two",
      adjustments: [first, second],
      skipped: 0,
      createdAt: "",
      updatedAt: "",
    } as Scenario;
    fakeBackend({});
    const user = userEvent.setup();
    open({
      scenarios: [existing],
      unmatched: { scenarioId: 9, adjustments: [first] as Scenario["adjustments"] },
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getAllByText(/doesn't match anything/)).toHaveLength(1);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    // The change that had the note is gone, and the one left must not inherit it.
    expect(screen.getByText(/Second:/)).toBeTruthy();
    expect(screen.queryByText(/doesn't match anything/)).toBeNull();
  });
});
