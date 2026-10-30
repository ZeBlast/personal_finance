import { lazy, Suspense, type ComponentType } from "react";
import { Loading } from "../components/common/Loading";
import { DashboardPage } from "../pages/DashboardPage";

/**
 * A page loaded the first time it is opened, not when the app starts, so the app starts with
 * only the dashboard's code. While its code arrives (a moment, from the computer itself), the
 * page area shows the loading placeholder.
 */
function lazyPage(load: () => Promise<ComponentType>): ComponentType {
  const Lazy = lazy(async () => ({ default: await load() }));
  return function LazyPage() {
    return (
      <Suspense fallback={<Loading lines={6} />}>
        <Lazy />
      </Suspense>
    );
  };
}

const AccountsPage = lazyPage(() => import("../pages/AccountsPage").then((m) => m.AccountsPage));
const AnalyticsPage = lazyPage(() => import("../pages/AnalyticsPage").then((m) => m.AnalyticsPage));
const BudgetsPage = lazyPage(() => import("../pages/BudgetsPage").then((m) => m.BudgetsPage));
const CalendarPage = lazyPage(() => import("../pages/CalendarPage").then((m) => m.CalendarPage));
const CategoriesPage = lazyPage(() =>
  import("../pages/CategoriesPage").then((m) => m.CategoriesPage),
);
const DataPage = lazyPage(() => import("../pages/DataPage").then((m) => m.DataPage));
const InsightsPage = lazyPage(() => import("../pages/InsightsPage").then((m) => m.InsightsPage));
const InvestmentsPage = lazyPage(() =>
  import("../pages/InvestmentsPage").then((m) => m.InvestmentsPage),
);
const NetworkPage = lazyPage(() => import("../pages/NetworkPage").then((m) => m.NetworkPage));
const PlanningPage = lazyPage(() => import("../pages/PlanningPage").then((m) => m.PlanningPage));
const DebtPage = lazyPage(() => import("../pages/DebtPage").then((m) => m.DebtPage));
const GoalsPage = lazyPage(() => import("../pages/GoalsPage").then((m) => m.GoalsPage));
const ReportsPage = lazyPage(() => import("../pages/ReportsPage").then((m) => m.ReportsPage));
const ReviewPage = lazyPage(() => import("../pages/ReviewPage").then((m) => m.ReviewPage));
const SandboxPage = lazyPage(() => import("../pages/SandboxPage").then((m) => m.SandboxPage));
const SettingsPage = lazyPage(() => import("../pages/SettingsPage").then((m) => m.SettingsPage));
const SubscriptionsPage = lazyPage(() =>
  import("../pages/SubscriptionsPage").then((m) => m.SubscriptionsPage),
);
const TaxesPage = lazyPage(() => import("../pages/TaxesPage").then((m) => m.TaxesPage));
const TransactionsPage = lazyPage(() =>
  import("../pages/TransactionsPage").then((m) => m.TransactionsPage),
);

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
    label: "What-if",
    sections: [{ path: "/sandbox", label: "What-if calculator", Page: SandboxPage }],
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
