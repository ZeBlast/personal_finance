// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { DashboardList } from "../../types/analytics";
import { DashboardActions } from "./DashboardActions";
import { DashboardSwitcher } from "./DashboardSwitcher";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const summary = (id: number, name: string) => ({ id, name, widgetCount: 3 });
const list = (count: number): DashboardList =>
  ({
    active: 1,
    dashboards: [summary(1, "Everyday"), summary(2, "Budget")].slice(0, count),
  }) as DashboardList;

describe("dashboard tabs", () => {
  it("marks the dashboard on show and switches on a click", async () => {
    const calls = fakeBackend({ "POST /dashboards/2/activate": {} });
    const onChanged = vi.fn();
    render(
      <DashboardSwitcher list={list(2)} disabled={false} onChanged={onChanged} onError={vi.fn()} />,
    );
    expect(screen.getByRole("tab", { name: "Everyday" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await userEvent.click(screen.getByRole("tab", { name: "Budget" }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /dashboards/2/activate"]);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("dashboard actions menu", () => {
  const show = (count = 2) =>
    render(<DashboardActions list={list(count)} onChanged={vi.fn()} onError={vi.fn()} />);

  it("holds New dashboard, Rename and Delete behind one button", async () => {
    show();
    expect(screen.queryByRole("menuitem")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dashboard actions" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "New dashboard",
      "Rename",
      "Delete",
    ]);
  });

  it("leaves out Delete when it is the only dashboard", async () => {
    show(1);
    await userEvent.click(screen.getByRole("button", { name: "Dashboard actions" }));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("works from the keyboard: opens on Down, moves with the arrows, closes on Escape", async () => {
    show();
    const button = screen.getByRole("button", { name: "Dashboard actions" });
    button.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "New dashboard" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("asks before deleting", async () => {
    const calls = fakeBackend({ "DELETE /dashboards/1": {} });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Dashboard actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(calls).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete dashboard" }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /dashboards/1"]);
  });
});
