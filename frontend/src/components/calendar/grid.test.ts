import { describe, expect, it } from "vitest";
import { monthGrid } from "./CalendarView";

describe("monthGrid", () => {
  it("lays a month out in whole weeks starting on Sunday, with blanks around it", () => {
    const weeks = monthGrid("2026-09"); // September 1, 2026 is a Tuesday
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]).toEqual([
      null,
      null,
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(weeks.at(-1)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      null,
      null,
      null,
    ]);
    expect(weeks).toHaveLength(5);
  });

  it("contains every day exactly once, in order", () => {
    for (const month of ["2026-01", "2026-02", "2028-02", "2026-08", "2026-12", "2027-05"]) {
      const days = monthGrid(month)
        .flat()
        .filter((d): d is string => d !== null);
      const last = Number(days.at(-1)!.slice(8));
      expect(days).toHaveLength(last);
      expect(days).toEqual(days.map((_, i) => `${month}-${String(i + 1).padStart(2, "0")}`));
    }
  });

  it("needs no blanks for a February that starts on Sunday and has 28 days", () => {
    const weeks = monthGrid("2026-02"); // February 1, 2026 is a Sunday
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((d) => d !== null)).toBe(true);
  });

  it("uses six rows when a month starts late in the week and has 31 days", () => {
    const weeks = monthGrid("2026-08"); // August 1, 2026 is a Saturday
    expect(weeks).toHaveLength(6);
    expect(weeks[0]!.filter((d) => d === null)).toHaveLength(6);
  });

  it("handles a leap-year February", () => {
    const days = monthGrid("2028-02").flat().filter(Boolean);
    expect(days).toHaveLength(29);
    expect(days.at(-1)).toBe("2028-02-29");
  });
});
