// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetToasts, toast } from "../../lib/toast";
import { Toaster } from "./Toaster";

afterEach(() => {
  cleanup();
  act(() => resetToasts());
});

describe("the pop-up messages", () => {
  it("shows a message, runs its Undo once, and closes it", async () => {
    const undo = vi.fn();
    render(<Toaster />);
    act(() => {
      toast("Groceries set on 3 transactions.", { action: { label: "Undo", run: undo } });
    });
    expect(screen.getByRole("status").textContent).toContain("Groceries set on 3 transactions.");

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Groceries set on 3 transactions.")).toBeNull();
  });

  it("shows an error as an alert, and Dismiss closes it", async () => {
    render(<Toaster />);
    act(() => {
      toast("Could not sync.", { kind: "error" });
    });
    expect(screen.getByRole("alert").textContent).toContain("Could not sync.");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
