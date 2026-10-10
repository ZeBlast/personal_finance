import { describe, expect, it } from "vitest";
import { CADENCE_LABEL, dueLabel, formatPercent, utilizationTone } from "./insights";

describe("utilizationTone", () => {
  it("uses the usual bands, with the boundary in the higher band", () => {
    expect(utilizationTone(0).tone).toBe("good");
    expect(utilizationTone(29.9).tone).toBe("good");
    expect(utilizationTone(30).tone).toBe("fair");
    expect(utilizationTone(49.9).tone).toBe("fair");
    expect(utilizationTone(50).tone).toBe("high");
    expect(utilizationTone(74.9).tone).toBe("high");
    expect(utilizationTone(75).tone).toBe("veryHigh");
    expect(utilizationTone(140).tone).toBe("veryHigh");
  });

  it("gives every band a label and a color", () => {
    for (const p of [0, 35, 60, 90]) {
      const t = utilizationTone(p);
      expect(t.label.length).toBeGreaterThan(2);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("dueLabel", () => {
  it("says when something is due in words", () => {
    expect(dueLabel("2026-10-05", "2026-10-05")).toBe("today");
    expect(dueLabel("2026-10-06", "2026-10-05")).toBe("tomorrow");
    expect(dueLabel("2026-10-04", "2026-10-05")).toBe("yesterday");
    expect(dueLabel("2026-10-12", "2026-10-05")).toBe("in 7 days");
    expect(dueLabel("2026-10-01", "2026-10-05")).toBe("4 days ago");
    expect(dueLabel("2026-01-01", "2025-12-31")).toBe("tomorrow");
  });
});

describe("formatPercent", () => {
  it("drops a pointless decimal", () => {
    expect(formatPercent(20.5)).toBe("20.5%");
    expect(formatPercent(30)).toBe("30%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(13.666)).toBe("13.7%");
  });
});

describe("CADENCE_LABEL", () => {
  it("covers every cadence", () => {
    expect(Object.keys(CADENCE_LABEL).sort()).toEqual([
      "biweekly",
      "monthly",
      "quarterly",
      "semimonthly",
      "weekly",
      "yearly",
    ]);
  });
});
