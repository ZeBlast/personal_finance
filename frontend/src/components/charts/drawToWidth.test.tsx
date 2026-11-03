// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendingHeatmap } from "../views/SpendingHeatmap";
import { ColumnChart } from "./ColumnChart";
import { LineChart } from "./LineChart";
import { drawnSize } from "./math";

/** A ResizeObserver that reports this width as soon as it starts watching. */
function reportWidth(width: number): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: unknown[]) => void) {}
      observe(): void {
        this.callback([{ contentRect: { width } }]);
      }
      disconnect(): void {}
    },
  );
}

const line = (drawToWidth: boolean) => (
  <LineChart
    drawToWidth={drawToWidth}
    format={String}
    series={[
      {
        key: "a",
        label: "A",
        color: "#000",
        points: [
          { date: "2026-01-01", value: 1 },
          { date: "2026-02-01", value: 2 },
        ],
      },
    ]}
  />
);
const columns = (drawToWidth: boolean) => (
  <ColumnChart
    drawToWidth={drawToWidth}
    format={String}
    series={[{ key: "a", label: "A", color: "#000" }]}
    groups={[{ key: "g", label: "G", values: [1] }]}
  />
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("drawing a chart to its width", () => {
  it("follows the width, with its height kept within limits", () => {
    expect(drawnSize(480)).toEqual({ width: 480, height: 200 });
    expect(drawnSize(200)).toEqual({ width: 200, height: 160 });
    expect(drawnSize(1800)).toEqual({ width: 1800, height: 320 });
  });

  it("draws line and column charts at the measured width", () => {
    reportWidth(900);
    const a = render(line(true));
    expect(a.container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 900 320");
    a.unmount();
    const b = render(columns(true));
    expect(b.container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 900 320");
  });

  it("leaves other charts as one drawing that scales", () => {
    reportWidth(900);
    const a = render(line(false));
    expect(a.container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 480 200");
    a.unmount();
    const b = render(columns(false));
    expect(b.container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 480 200");
  });
});

describe("the spending heatmap", () => {
  it("opens on its newest weeks, with its key outside what scrolls", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const { container } = render(
      <MemoryRouter>
        <SpendingHeatmap rows={[]} end="2026-11-02" money={String} />
      </MemoryRouter>,
    );
    const weeks = container.querySelector<HTMLElement>("[data-heatmap-weeks]")!;
    expect(weeks.scrollLeft).toBe(900);
    expect(container.textContent).toContain("Less");
    expect(weeks.textContent).not.toContain("Less");
  });
});
