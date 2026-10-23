import type { ComponentType } from "react";
import { AccountsPage } from "../pages/AccountsPage";
import { AnalyticsPage } from "../pages/AnalyticsPage";
import { BudgetsPage } from "../pages/BudgetsPage";
import { CalendarPage } from "../pages/CalendarPage";
import { CategoriesPage } from "../pages/CategoriesPage";
import { DashboardPage } from "../pages/DashboardPage";
import { DataPage } from "../pages/DataPage";
import { InsightsPage } from "../pages/InsightsPage";
import { InvestmentsPage } from "../pages/InvestmentsPage";
import { NetworkPage } from "../pages/NetworkPage";
import { PlanningPage } from "../pages/PlanningPage";
import { DebtPage } from "../pages/DebtPage";
import { GoalsPage } from "../pages/GoalsPage";
import { ReportsPage } from "../pages/ReportsPage";
import { ReviewPage } from "../pages/ReviewPage";
import { SandboxPage } from "../pages/SandboxPage";
import { SettingsPage } from "../pages/SettingsPage";
import { SubscriptionsPage } from "../pages/SubscriptionsPage";
import { TaxesPage } from "../pages/TaxesPage";
import { TransactionsPage } from "../pages/TransactionsPage";

export interface AppRoute {
  path: string;
  label: string;
  Page: ComponentType;
}

/**
 * One of the main areas in the sidebar. An area with several sections shows them as tabs; the
 * first section lives at the area's own path, the others below it.
 */
export interface AppArea {
  path: string;
  label: string;
  sections: AppRoute[];
}

/** Single source of truth for navigation and routing: nine areas, each with its sections. */
export const areas: AppArea[] = [
  {
    path: "/",
    label: "Dashboard",
    sections: [{ path: "/", label: "Dashboard", Page: DashboardPage }],
  },
  {
    path: "/transactions",
    label: "Transactions",
    sections: [
      { path: "/transactions", label: "Activity", Page: TransactionsPage },
      { path: "/transactions/review", label: "Review", Page: ReviewPage },
      { path: "/transactions/categories", label: "Categories & rules", Page: CategoriesPage },
    ],
  },
  {
    path: "/calendar",
    label: "Calendar",
    sections: [{ path: "/calendar", label: "Calendar", Page: CalendarPage }],
  },
  {
    path: "/planning",
    label: "Planning",
    sections: [
      { path: "/planning", label: "Forecast & bills", Page: PlanningPage },
      { path: "/planning/subscriptions", label: "Subscriptions", Page: SubscriptionsPage },
      { path: "/planning/budgets", label: "Budgets", Page: BudgetsPage },
      { path: "/planning/goals", label: "Goals", Page: GoalsPage },
      { path: "/planning/debt", label: "Debt payoff", Page: DebtPage },
    ],
  },
  {
    path: "/accounts",
    label: "Accounts",
    sections: [
      { path: "/accounts", label: "Accounts", Page: AccountsPage },
      { path: "/accounts/investments", label: "Investments", Page: InvestmentsPage },
    ],
  },
  {
    path: "/reports",
    label: "Reports",
    sections: [
      { path: "/reports", label: "Monthly summary", Page: ReportsPage },
      { path: "/reports/spending", label: "Spending", Page: InsightsPage },
      { path: "/reports/net-worth", label: "Net worth", Page: AnalyticsPage },
      { path: "/reports/network", label: "Network", Page: NetworkPage },
    ],
  },
  {
    path: "/taxes",
    label: "Taxes",
    sections: [{ path: "/taxes", label: "Taxes", Page: TaxesPage }],
  },
  {
    path: "/sandbox",
    label: "Sandbox",
    sections: [{ path: "/sandbox", label: "Sandbox", Page: SandboxPage }],
  },
  {
    path: "/settings",
    label: "Settings",
    sections: [
      { path: "/settings", label: "General", Page: SettingsPage },
      { path: "/settings/data", label: "Data & backups", Page: DataPage },
    ],
  },
];

/** Every page, for routing and search. */
export const routes: AppRoute[] = areas.flatMap((a) => a.sections);

/**
 * Pages that moved into an area, at their old address. Old links, widgets and saved orders keep
 * working: the old address opens the new one (with the same filters).
 */
export const LEGACY_PATHS: Record<string, string> = {
  "/review": "/transactions/review",
  "/categories": "/transactions/categories",
  "/subscriptions": "/planning/subscriptions",
  "/budgets": "/planning/budgets",
  "/goals": "/planning/goals",
  "/investments": "/accounts/investments",
  "/insights": "/reports/spending",
  "/reports/insights": "/reports/spending",
  "/analytics": "/reports/net-worth",
  "/network": "/reports/network",
  "/data": "/settings/data",
};

/**
 * The area a page belongs to (the area of `/reports/network` is `/reports`), or null for an
 * address the app no longer has. Pure.
 */
export function areaOf(path: string): string | null {
  const moved = LEGACY_PATHS[path] ?? path;
  if (moved === "/") return "/";
  const area = areas.find(
    (a) => a.path !== "/" && (moved === a.path || moved.startsWith(`${a.path}/`)),
  );
  return area ? area.path : null;
}

/**
 * A saved sidebar order from before the areas: each page becomes its area, in the order the user
 * first placed one of its pages; repeats drop out. Pure.
 */
export function migrateNavOrder(order: string[]): string[] {
  const out: string[] = [];
  for (const path of order) {
    const area = areaOf(path);
    if (area !== null && !out.includes(area)) out.push(area);
  }
  return out;
}
