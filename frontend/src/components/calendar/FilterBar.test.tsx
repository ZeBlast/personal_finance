// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";
import { ALL_SHOWN } from "./filters";

afterEach(cleanup);

describe("calendar Show chips", () => {
  it("fill and tick the ones on, and leave the ones off as an outline", () => {
    render(
      <FilterBar
        filters={{ ...ALL_SHOWN, pending: false }}
        onChange={vi.fn()}
        lowCash={0}
        onLowCash={vi.fn()}
        searchable={false}
      />,
    );
    const on = screen.getByRole("button", { name: "Recorded" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.className).toContain("bg-blue-600");
    expect(on.querySelector("svg")).not.toBeNull();

    const off = screen.getByRole("button", { name: "Pending" });
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(off.className).not.toContain("bg-blue-600");
    expect(off.className).toContain("border-slate-300");
    expect(off.querySelector("svg")).toBeNull();
  });
});
