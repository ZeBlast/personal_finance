// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

afterEach(cleanup);

describe("ActionMenu", () => {
  it("returns focus to its button before running a chosen item", () => {
    let focusedWhenRun: Element | null = null;
    const onSelect = vi.fn(() => {
      focusedWhenRun = document.activeElement;
    });
    render(<ActionMenu label="More" items={[{ label: "Rename", onSelect }]} />);
    const button = screen.getByRole("button", { name: "More" });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(focusedWhenRun).toBe(button);
    expect(document.activeElement).toBe(button);
  });
});
