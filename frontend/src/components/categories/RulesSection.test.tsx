// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetToasts } from "../../lib/toast";
import { fakeBackend } from "../../test/fakeBackend";
import type { Category } from "../../types/api";
import { Toaster } from "../common/Toaster";
import { RulesSection } from "./RulesSection";

afterEach(() => {
  cleanup();
  act(() => resetToasts());
  vi.unstubAllGlobals();
});

const categories = [
  { id: 3, name: "Dining", parentId: null, color: null, active: true },
] as unknown as Category[];

const settings = { currency: "USD", ownNames: [] };
const SYNC_EVENT = "pf-sync-finished";

function countDataChanges(): () => number {
  let n = 0;
  const onChange = (): void => void (n += 1);
  window.addEventListener(SYNC_EVENT, onChange);
  return () => n;
}

describe("rule changes", () => {
  it("saving a rule that moved transactions toasts it with Undo, and undoing says what was put back", async () => {
    // jsdom has no scrolling; the category list asks for it.
    Element.prototype.scrollIntoView = vi.fn();
    const changes = countDataChanges();
    const calls = fakeBackend({
      "GET /rules": [],
      "GET /rules/batches": [],
      "GET /settings": settings,
      "POST /rules/preview": {
        matchCount: 3,
        sample: [],
        changeCount: 3,
        changes: [],
        totals: [],
        manualCount: 0,
      },
      "POST /rules": { id: 5, batchId: 9, changeCount: 3 },
      "POST /rules/batches/9/undo": { restored: 3, kept: [] },
    });
    render(
      <>
        <RulesSection categories={categories} />
        <Toaster />
      </>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "New rule" }));
    await userEvent.type(screen.getByLabelText(/This text/), "pizza");
    await userEvent.click(screen.getByLabelText("Use this category"));
    await userEvent.click(await screen.findByRole("option", { name: "Dining" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByText("Moved 3 transactions.")).textContent).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/rules")?.body).toMatchObject({
      scope: "all",
    });
    expect(changes()).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Put back 3 transactions.")).toBeTruthy();
    expect(changes()).toBe(2);
  });

  it("undoes a batch from Recent changes and says what stayed", async () => {
    const changes = countDataChanges();
    fakeBackend({
      "GET /rules": [],
      "GET /rules/batches": [
        {
          id: 4,
          kind: "rules_applied",
          label: "Apply rules now (every transaction re-checked)",
          ruleId: null,
          changeCount: 2,
          createdAt: "2026-11-01T10:00:00.000Z",
          undoneAt: null,
        },
      ],
      "GET /settings": settings,
      "POST /rules/batches/4/undo": { restored: 1, kept: [{}] },
    });
    render(
      <>
        <RulesSection categories={categories} />
        <Toaster />
      </>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(
        "Put back 1 transaction. 1 you changed since keeps its new category.",
      ),
    ).toBeTruthy();
    expect(changes()).toBe(1);
  });
});
