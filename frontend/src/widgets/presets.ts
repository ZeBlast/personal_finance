import { api } from "../api/client";
import { monthOf, today } from "../lib/period";
import type { BudgetMonth, DashboardLayout } from "../types/analytics";
import { buildDefaultLayout, DEFAULT_PLAN, planToPlaced, tile, type PlannedWidget } from "./layout";
import { allWidgets } from "./registry";
import type { AnyWidget, PlacedWidget } from "./types";

/**
 * Ready-made dashboards, each for one question. They are ordinary dashboards once made: anything in
 * them can be moved, changed or removed, and a whole one can be deleted and made again from "New
 * dashboard". Plans use the classic 12 columns and 60px rows, like the default dashboard.
 */
export interface DashboardPreset {
  name: string;
  /** What it answers, for the "New dashboard" choice. */
  blurb: string;
  /** The widgets; `capIds` are categories with a spending cap, the fullest first. */
  plan: (capIds: number[]) => readonly PlannedWidget[];
}

const BUCKETS_SHOWN = 4;
const bucket = (x: number, category: number | "") => ({
  widgetType: "spending-bucket",
  x,
  y: 0,
  w: 3,
  h: 4,
  config: { category: String(category), _hideHeader: true },
});

/** A bucket for each of the fullest caps (or one for all of them), with the row's rest filled. */
function bucketRow(capIds: number[]): PlannedWidget[] {
  const shown: Array<number | ""> = capIds.length > 0 ? capIds.slice(0, BUCKETS_SHOWN) : [""];
  const row: PlannedWidget[] = shown.map((id, i) => bucket(i * 3, id));
  const used = shown.length * 3;
  if (used < 12) {
    row.push({ widgetType: "daily-brief", x: used, y: 0, w: 12 - used, h: 4 });
  }
  return row;
}

export const PRESETS: readonly DashboardPreset[] = [
  {
    name: "Everyday",
    blurb: "Where you stand, the days ahead, this month's spending, and what happened.",
    plan: () => DEFAULT_PLAN,
  },
  {
    name: "Budget",
    blurb: "A bucket for your fullest spending caps, and where this month's money is going.",
    plan: (capIds) => [
      ...bucketRow(capIds),
      { widgetType: "budget-progress", x: 0, y: 4, w: 6, h: 5 },
      { widgetType: "spending-by-category", x: 6, y: 4, w: 6, h: 5 },
      { widgetType: "top-merchants", x: 0, y: 9, w: 6, h: 5 },
      { widgetType: "recurring-charges", x: 6, y: 9, w: 6, h: 5 },
    ],
  },
  {
    name: "Cash & bills",
    blurb: "What is coming: cash ahead, card bills, the calendar, and what repeats.",
    plan: () => [
      { widgetType: "home-summary", x: 0, y: 0, w: 12, h: 2, config: { _hideHeader: true } },
      { widgetType: "cash-forecast", x: 0, y: 2, w: 8, h: 6, config: { whatIf: true } },
      { widgetType: "credit-cards", x: 8, y: 2, w: 4, h: 6 },
      { widgetType: "calendar", x: 0, y: 8, w: 8, h: 7 },
      { widgetType: "recurring-charges", x: 8, y: 8, w: 4, h: 4 },
      { widgetType: "review-queue", x: 8, y: 12, w: 4, h: 3 },
    ],
  },
  {
    name: "Big picture",
    blurb: "The long view: net worth, the year so far, cash flow, and investments.",
    plan: () => [
      { ...tile("net-worth", 0), y: 0 },
      { ...tile("summary-number", 3, { metric: "income" }), y: 0 },
      { ...tile("summary-number", 6, { metric: "spending" }), y: 0 },
      { ...tile("summary-number", 9, { metric: "net" }), y: 0 },
      { widgetType: "net-worth-history", x: 0, y: 2, w: 8, h: 5 },
      { widgetType: "account-balances", x: 8, y: 2, w: 4, h: 5 },
      { widgetType: "cash-flow-map", x: 0, y: 7, w: 12, h: 6 },
      { widgetType: "year-so-far", x: 0, y: 13, w: 6, h: 6 },
      { widgetType: "portfolio-allocation", x: 6, y: 13, w: 6, h: 6 },
    ],
  },
  {
    name: "Spending",
    blurb: "Habits a monthly total hides: which days, which merchants, and what is growing.",
    plan: () => [
      { widgetType: "spending-heatmap", x: 0, y: 0, w: 12, h: 3, config: { weeks: "52" } },
      { widgetType: "spending-by-category", x: 0, y: 3, w: 4, h: 5 },
      { widgetType: "merchant-trends", x: 4, y: 3, w: 8, h: 5 },
      { widgetType: "income-vs-spending", x: 0, y: 8, w: 6, h: 5 },
      { widgetType: "top-merchants", x: 6, y: 8, w: 6, h: 5 },
      { widgetType: "recent-transactions", x: 0, y: 13, w: 12, h: 5 },
    ],
  },
];

export const presetNamed = (name: string): DashboardPreset | undefined =>
  PRESETS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());

/** A preset as widgets, skipping any not installed. Pure. */
export function presetLayout(
  preset: DashboardPreset,
  capIds: number[],
  widgets: AnyWidget[],
): PlacedWidget[] {
  return planToPlaced(preset.plan(capIds), widgets);
}

/** Categories with a cap this month, the fullest first. Nothing if they cannot be read. */
async function fullestCaps(): Promise<number[]> {
  const day = today();
  try {
    const month = await api<BudgetMonth>(`/budgets?month=${monthOf(day)}&today=${day}`);
    return [...month.budgets]
      .sort((a, b) => b.percentUsed - a.percentUsed)
      .map((b) => b.categoryId);
  } catch {
    return [];
  }
}

/** The layout a dashboard's name calls for: its preset's, or else the default dashboard's. */
export async function defaultLayoutFor(name: string): Promise<PlacedWidget[]> {
  const preset = presetNamed(name);
  if (!preset || preset === PRESETS[0]) return buildDefaultLayout(allWidgets());
  return presetLayout(preset, await fullestCaps(), allWidgets());
}

const saveLayout = (dashboardId: number, widgets: PlacedWidget[]): Promise<DashboardLayout> =>
  api<DashboardLayout>(`/dashboard/widgets?dashboardId=${dashboardId}`, {
    method: "PUT",
    body: JSON.stringify({
      widgets: widgets.map(({ widgetType, enabled, x, y, w, h, config }) => ({
        widgetType,
        enabled,
        x,
        y,
        w,
        h,
        config,
      })),
    }),
  });

/** Fills a dashboard with a preset, for one just created. */
export async function applyPreset(dashboardId: number, preset: DashboardPreset): Promise<void> {
  await saveLayout(dashboardId, presetLayout(preset, await fullestCaps(), allWidgets()));
}

/**
 * Adds the ready-made dashboards as tabs, once. Nothing already there is touched: a name in use is
 * skipped, and whoever has no accounts yet already gets "Everyday" as their first dashboard, so it
 * is not added twice. The active dashboard does not change. Marked done only if every one worked,
 * so a failure tries again next time.
 */
export async function addDefaultViews(
  existingNames: string[],
  firstDashboardIsNew: boolean,
): Promise<void> {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const caps = await fullestCaps();
  for (const preset of PRESETS) {
    if (taken.has(preset.name.toLowerCase())) continue;
    if (preset.name === "Everyday" && firstDashboardIsNew) continue;
    const created = await api<{ id: number }>("/dashboards", {
      method: "POST",
      body: JSON.stringify({ name: preset.name }),
    });
    await saveLayout(created.id, presetLayout(preset, caps, allWidgets()));
  }
  await api("/settings", { method: "PATCH", body: JSON.stringify({ dashboardViewsAdded: true }) });
}
