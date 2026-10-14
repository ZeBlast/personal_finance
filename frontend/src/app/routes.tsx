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

/** Single source of truth for navigation and routing. */
export const routes: AppRoute[] = [
  { path: "/", label: "Dashboard", Page: DashboardPage },
  { path: "/transactions", label: "Transactions", Page: TransactionsPage },
  { path: "/network", label: "Network", Page: NetworkPage },
  { path: "/review", label: "Review", Page: ReviewPage },
  { path: "/calendar", label: "Calendar", Page: CalendarPage },
  { path: "/planning", label: "Planning", Page: PlanningPage },
  { path: "/subscriptions", label: "Subscriptions", Page: SubscriptionsPage },
  { path: "/goals", label: "Goals", Page: GoalsPage },
  { path: "/categories", label: "Categories", Page: CategoriesPage },
  { path: "/accounts", label: "Accounts", Page: AccountsPage },
  { path: "/budgets", label: "Budgets", Page: BudgetsPage },
  { path: "/investments", label: "Investments", Page: InvestmentsPage },
  { path: "/insights", label: "Insights", Page: InsightsPage },
  { path: "/taxes", label: "Taxes", Page: TaxesPage },
  { path: "/reports", label: "Month report", Page: ReportsPage },
  { path: "/sandbox", label: "Sandbox", Page: SandboxPage },
  { path: "/analytics", label: "Net worth history", Page: AnalyticsPage },
  { path: "/data", label: "Data & backups", Page: DataPage },
  { path: "/settings", label: "Settings", Page: SettingsPage },
];
