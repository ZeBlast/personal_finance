// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import { fromGrid, overlaps } from "./layout";
import { addDefaultViews, presetLayout, presetNamed, PRESETS } from "./presets";
import { allWidgets, getWidget } from "./registry";

afterEach(() => vi.unstubAllGlobals());

const layouts = (capIds: number[]) =>
  PRESETS.map((p) => ({
    name: p.name,
    plan: p.plan(capIds),
    widgets: presetLayout(p, capIds, allWidgets()),
  }));

describe("the ready-made dashboards", () => {
  for (const capIds of [[], [1], [1, 2, 3, 4, 5, 6]]) {
    it(`use real widgets, at allowed sizes, inside the grid, with ${capIds.length} caps`, () => {
      for (const { name, plan, widgets } of layouts(capIds)) {
        expect(widgets.length, `${name}: every planned widget exists`).toBe(plan.length);
        for (const w of widgets) {
          const definition = getWidget(w.widgetType)!;
          const size = fromGrid(w);
          expect(w.x + w.w, `${name}: ${w.widgetType} fits`).toBeLessThanOrEqual(24);
          expect(size.w, `${name}: ${w.widgetType} width`).toBeGreaterThanOrEqual(
            definition.minSize?.w ?? 1,
          );
          expect(size.h, `${name}: ${w.widgetType} height`).toBeGreaterThanOrEqual(
            definition.minSize?.h ?? 1,
          );
        }
      }
    });

    it(`have no widgets on top of each other, with ${capIds.length} caps`, () => {
      for (const { name, widgets } of layouts(capIds)) {
        widgets.forEach((a, i) =>
          widgets.slice(i + 1).forEach((b) => {
            expect(overlaps(a, b), `${name}: ${a.widgetType} and ${b.widgetType}`).toBe(false);
          }),
        );
      }
    });
  }

  it("are found by name, whatever the case", () => {
    expect(presetNamed(" cash & BILLS ")?.name).toBe("Cash & bills");
    expect(presetNamed("Investing")).toBeUndefined();
  });

  it("still know a dashboard saved as Budget, now called Spending caps", () => {
    expect(presetNamed("Spending caps")?.name).toBe("Spending caps");
    expect(presetNamed(" budget ")).toBe(presetNamed("Spending caps"));
  });

  it("give the Spending caps dashboard a bucket for each of the fullest caps", () => {
    const budget = presetNamed("Spending caps")!;
    const buckets = (capIds: number[]) =>
      presetLayout(budget, capIds, allWidgets()).filter((w) => w.widgetType === "spending-bucket");
    expect(buckets([7, 8, 9, 10, 11]).map((w) => w.config["category"])).toEqual([
      "7",
      "8",
      "9",
      "10",
    ]);
  });

  it("fall back to one bucket for every cap together, with no caps yet", () => {
    const layout = presetLayout(presetNamed("Spending caps")!, [], allWidgets());
    expect(layout.filter((w) => w.widgetType === "spending-bucket")).toHaveLength(1);
    expect(layout.some((w) => w.widgetType === "daily-brief")).toBe(true);
  });
});

describe("adding them as tabs", () => {
  const backend = () => {
    let next = 10;
    return fakeBackend({
      "POST /dashboards": () => ({ id: (next += 1) }),
      "PATCH /settings": {},
      [`/budgets?month=${new Date().toLocaleDateString("en-CA").slice(0, 7)}&today=${new Date().toLocaleDateString("en-CA")}`]:
        { budgets: [] },
    });
  };
  const created = (calls: ReturnType<typeof fakeBackend>) =>
    calls
      .filter((c) => c.method === "POST" && c.path === "/dashboards")
      .map((c) => (c.body as { name: string }).name);

  it("adds each one, fills it, and remembers", async () => {
    const calls = backend();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).includes("/dashboard/widgets")
        ? new Response(JSON.stringify({ widgets: [] }), { status: 200 })
        : original(url as string, init),
    );
    await addDefaultViews(["Main"], false);
    expect(created(calls)).toEqual(PRESETS.map((p) => p.name));
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/settings",
      body: { dashboardViewsAdded: true },
    });
  });

  it("leaves out Everyday for someone just starting, and any name already in use", async () => {
    const calls = backend();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).includes("/dashboard/widgets")
        ? new Response(JSON.stringify({ widgets: [] }), { status: 200 })
        : original(url as string, init),
    );
    await addDefaultViews(["Main", "budget"], true);
    expect(created(calls)).toEqual(["Cash & bills", "Big picture", "Spending"]);
  });

  it("does not add Spending caps again when a dashboard is still named Budget", async () => {
    const calls = backend();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).includes("/dashboard/widgets")
        ? new Response(JSON.stringify({ widgets: [] }), { status: 200 })
        : original(url as string, init),
    );
    await addDefaultViews(["Main", "Budget"], false);
    expect(created(calls)).not.toContain("Spending caps");
  });

  it("does not mark it done if one fails, so it tries again next time", async () => {
    const calls = fakeBackend({ "PATCH /settings": {} });
    await expect(addDefaultViews(["Main"], false)).rejects.toThrow();
    expect(calls.some((c) => c.path === "/settings")).toBe(false);
  });
});
