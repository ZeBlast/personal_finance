// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import { CategoriesSection } from "./CategoriesSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const category = {
  id: 7,
  name: "Groceries",
  parentId: null,
  color: null,
  active: true,
  incomeTreatment: null,
  transactionCount: 0,
  ruleCount: 0,
};

describe("categories list", () => {
  it("keeps each row's actions behind one menu, with Delete asking first", async () => {
    const calls = fakeBackend({
      "GET /categories?includeInactive=1": [category],
      "DELETE /categories/7": { outcome: "deleted" },
    });
    render(<CategoriesSection onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Groceries" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Edit",
      "Archive",
      "Delete",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /categories/7");
  });
});
