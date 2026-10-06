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
import { SettingsPage } from "../pages/SettingsPage";
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
  { path: "/calendar", label: "Calendar", Page: CalendarPage },
  { path: "/categories", label: "Categories", Page: CategoriesPage },
  { path: "/accounts", label: "Accounts", Page: AccountsPage },
  { path: "/budgets", label: "Budgets", Page: BudgetsPage },
  { path: "/investments", label: "Investments", Page: InvestmentsPage },
  { path: "/insights", label: "Insights", Page: InsightsPage },
  { path: "/analytics", label: "Net worth history", Page: AnalyticsPage },
  { path: "/data", label: "Data & backups", Page: DataPage },
  { path: "/settings", label: "Settings", Page: SettingsPage },
];
