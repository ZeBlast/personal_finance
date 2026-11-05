// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import { ScenarioDialog } from "./ScenarioDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scenario dialog", () => {
  it("saves a new scenario with a one-off change and writes nothing else", async () => {
    const saved = { id: 4, name: "Car", adjustments: [], skipped: 0, createdAt: "", updatedAt: "" };
    const calls = fakeBackend({
      "/subscriptions": { subscriptions: [] },
      "/planned": [],
      "/goals": [],
      "POST /forecast/scenarios": saved,
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <ScenarioDialog
        scenarios={[]}
        currency="USD"
        today="2026-11-05"
        days={60}
        unmatched={null}
        onChanged={onChanged}
        onClose={() => {}}
      />,
    );
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
});
