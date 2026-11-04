// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { splitLeadingEmpty, YearMonthsTable, type YearMonthRow } from "./YearMonthsTable";

afterEach(cleanup);

function row(month: string, over: Partial<YearMonthRow> = {}): YearMonthRow {
  return {
    month,
    incomeMinor: 0,
    spendingMinor: 0,
    savedMinor: 0,
    capsHeld: 0,
    capsCount: 0,
    netWorthMinor: null,
    partial: false,
    ...over,
  };
}

const money = (n: number) => `$${n / 100}`;

describe("year months table", () => {
  it("splits the empty months before the first month with data", () => {
    const months = [
      row("2026-01"),
      row("2026-02"),
      row("2026-03", { spendingMinor: 500 }),
      row("2026-04"),
    ];
    const { emptyBefore, rest } = splitLeadingEmpty(months);
    expect(emptyBefore).toBe("2026-03");
    expect(rest.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("splits nothing when the first month has data or there is no data at all", () => {
    expect(splitLeadingEmpty([row("2026-01", { incomeMinor: 1 })]).emptyBefore).toBeNull();
    expect(splitLeadingEmpty([row("2026-01"), row("2026-02")]).rest).toHaveLength(2);
  });

  it("shows one 'No data before' line and a dash for missing net worth", () => {
    render(
      <YearMonthsTable
        months={[
          row("2026-01"),
          row("2026-02"),
          row("2026-03", { spendingMinor: 500, netWorthMinor: 10000 }),
          row("2026-04", { spendingMinor: 500 }),
        ]}
        money={money}
      />,
    );
    expect(screen.getByText(/No data before/)).toBeTruthy();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
    // Two data months remain as rows, plus the header and the one summary line.
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
});
