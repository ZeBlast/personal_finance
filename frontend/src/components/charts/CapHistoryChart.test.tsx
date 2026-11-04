// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CapHistoryChart } from "./CapMeter";

afterEach(cleanup);

describe("a cap's history chart", () => {
  it("colours a bar red only for a month over its cap", () => {
    const { container } = render(
      <CapHistoryChart
        history={[
          { month: "2026-08", spentMinor: 12_000, capMinor: 10_000 },
          { month: "2026-09", spentMinor: 8_000, capMinor: 10_000 },
          { month: "2026-10", spentMinor: 9_000, capMinor: null },
        ]}
      />,
    );
    const bars = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("class") ?? "");
    expect(bars[0]).toContain("fill-red-500");
    expect(bars[1]).toContain("fill-slate-300");
    expect(bars[1]).not.toContain("red");
    expect(bars[2]).toContain("fill-slate-300");
  });
});
