// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendingBucket } from "../components/charts/SpendingBucket";
import { AnimatedNumber } from "../components/common/AnimatedNumber";
import type { BudgetMonth } from "../types/analytics";
import { nextFreeSpot } from "../widgets/layout";
import { bucketReading } from "../widgets/SpendingBucketWidget";
import type { PlacedWidget } from "../widgets/types";
import {
  BUCKET,
  bucketFill,
  bucketHalfWidth,
  bucketOverflow,
  prefersReducedMotion,
  tween,
  waterY,
} from "./motion";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reduceMotion = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));

describe("tweening", () => {
  it("starts and ends exactly, moving fastest at first", () => {
    expect(tween(100, 200, 0)).toBe(100);
    expect(tween(100, 200, 1)).toBe(200);
    expect(tween(100, 200, 0.5)).toBeGreaterThan(150);
    expect(tween(100, 200, 5)).toBe(200);
  });
});

describe("how full a bucket is", () => {
  it("fills in proportion, up to the rim", () => {
    expect(bucketFill(0, 1000)).toBe(0);
    expect(bucketFill(250, 1000)).toBe(0.25);
    expect(bucketFill(5000, 1000)).toBe(1);
  });

  it("treats refunds as empty, and any spending with no cap left as full", () => {
    expect(bucketFill(-100, 1000)).toBe(0);
    expect(bucketFill(10, 0)).toBe(1);
    expect(bucketFill(10, -500)).toBe(1);
  });

  it("overflows only past the cap, in proportion, with a limit", () => {
    expect(bucketOverflow(1000, 1000)).toBe(0);
    expect(bucketOverflow(1500, 1000)).toBe(0.5);
    expect(bucketOverflow(9000, 1000)).toBe(1);
  });

  it("puts the water out of sight when empty and just under the rim when full", () => {
    expect(waterY(0)).toBeGreaterThan(BUCKET.bottomY);
    expect(waterY(1)).toBeGreaterThan(BUCKET.rimY);
    expect(waterY(1)).toBeLessThan(waterY(0.5));
  });

  it("narrows toward the base, without going past either end", () => {
    expect(bucketHalfWidth(BUCKET.rimY)).toBe(BUCKET.rimHalfWidth);
    expect(bucketHalfWidth(BUCKET.bottomY)).toBe(BUCKET.bottomHalfWidth);
    expect(bucketHalfWidth(999)).toBe(BUCKET.bottomHalfWidth);
  });
});

describe("the bucket", () => {
  const bucket = (spentMinor: number, extra = {}) => (
    <SpendingBucket
      spentMinor={spentMinor}
      capMinor={1000}
      status={spentMinor > 1000 ? "over" : "ok"}
      label="Food spending bucket"
      description="reading"
      {...extra}
    />
  );

  it("reads out in words", () => {
    render(bucket(500));
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe("reading");
  });

  it("drops nothing in when first shown, or when spending falls", () => {
    const { rerender } = render(bucket(500));
    expect(screen.queryByTestId("bucket-drop")).toBeNull();
    rerender(bucket(200));
    expect(screen.queryByTestId("bucket-drop")).toBeNull();
  });

  it("drops one in when spending goes up", () => {
    const { rerender } = render(bucket(500));
    rerender(bucket(600));
    screen.getByTestId("bucket-drop");
    screen.getByTestId("bucket-ripple");
  });

  it("spills and puddles only past the cap", () => {
    const { rerender } = render(bucket(1000));
    expect(screen.queryByTestId("bucket-spill")).toBeNull();
    rerender(bucket(1400));
    screen.getByTestId("bucket-spill");
    screen.getByTestId("bucket-puddle");
  });

  it("marks an even pace when there is one", () => {
    const { rerender } = render(bucket(500));
    expect(screen.queryByTestId("bucket-pace")).toBeNull();
    rerender(bucket(500, { expectedMinor: 400 }));
    screen.getByTestId("bucket-pace");
  });

  it("with reduced motion, shows the level at once and drops nothing in", () => {
    reduceMotion();
    expect(prefersReducedMotion()).toBe(true);
    const { container, rerender } = render(bucket(500));
    const level = container.querySelector<SVGGElement>(".pf-bucket-level")!;
    expect(level.style.transform).toContain(`${waterY(0.5)}px`);
    rerender(bucket(700));
    expect(screen.queryByTestId("bucket-drop")).toBeNull();
  });
});

describe("what a bucket shows", () => {
  const cap = {
    categoryId: 1,
    categoryName: "Food",
    categoryColor: "#123456",
    parentId: null,
    status: "risk",
    spentMinor: 700,
    availableMinor: 1000,
    remainingMinor: 300,
    expectedMinor: 500,
    projectedMinor: 1100,
  };
  const month = {
    month: "2026-11",
    budgets: [cap],
    totals: { budgetedMinor: 1000, spentMinor: 700, remainingMinor: 300 },
    unbudgetedSpendingMinor: 0,
  } as unknown as BudgetMonth;

  it("finds the chosen category's cap", () => {
    expect(bucketReading(month, 1)).toMatchObject({
      name: "Food",
      status: "risk",
      spentMinor: 700,
    });
  });

  it("says when that category has no cap", () => {
    expect(bucketReading(month, 2)).toBeNull();
  });

  it("adds every cap together when no category is chosen", () => {
    expect(bucketReading(month, null)).toMatchObject({
      name: "All spending caps",
      spentMinor: 700,
      availableMinor: 1000,
      status: "ok",
      expectedMinor: 500,
    });
  });

  it("has nothing to add up with no caps", () => {
    expect(bucketReading({ ...month, budgets: [] }, null)).toBeNull();
  });
});

describe("where a new widget goes", () => {
  const at = (x: number, y: number, w: number, h: number): PlacedWidget => ({
    key: `${x}-${y}`,
    widgetType: "x",
    enabled: true,
    x,
    y,
    w,
    h,
    config: {},
  });

  it("starts at the top left of an empty dashboard", () => {
    expect(nextFreeSpot({ w: 6, h: 8 }, [])).toEqual({ x: 0, y: 0, w: 6, h: 8 });
  });

  it("sits beside the last widget when it fits", () => {
    expect(nextFreeSpot({ w: 6, h: 8 }, [at(0, 0, 6, 8)])).toMatchObject({ x: 6, y: 0 });
  });

  it("starts a new row when it does not fit", () => {
    expect(nextFreeSpot({ w: 12, h: 8 }, [at(0, 0, 18, 8)])).toMatchObject({ x: 0, y: 8 });
  });

  it("ignores hidden widgets", () => {
    const hidden = { ...at(0, 0, 24, 8), enabled: false };
    expect(nextFreeSpot({ w: 6, h: 8 }, [hidden])).toMatchObject({ x: 0, y: 0 });
  });
});

describe("a figure that changes", () => {
  const format = (n: number) => `$${n}`;

  it("shows its first value straight away, without counting up", () => {
    render(<AnimatedNumber value={500} format={format} />);
    screen.getByText("$500");
  });

  it("counts to a new value, always telling screen readers the real one", async () => {
    const { rerender } = render(<AnimatedNumber value={500} format={format} />);
    act(() => rerender(<AnimatedNumber value={900} format={format} />));
    screen.getByLabelText("$900");
    await waitFor(() => screen.getByText("$900"), { timeout: 1500 });
  });

  it("jumps straight there with reduced motion", async () => {
    reduceMotion();
    const { rerender } = render(<AnimatedNumber value={500} format={format} />);
    rerender(<AnimatedNumber value={900} format={format} />);
    await waitFor(() => screen.getByText("$900"), { timeout: 100 });
  });
});
