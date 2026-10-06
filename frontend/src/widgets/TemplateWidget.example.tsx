/**
 * A COMPLETE, WORKING EXAMPLE OF A WIDGET. Copy this file, rename it to `SomethingWidget.tsx`
 * (the name must end in `Widget.tsx` to be picked up), then change the parts marked CHANGE.
 * This copy is not loaded on the dashboard because its name ends in `.example.tsx`; it is still
 * type-checked and tested, so it never goes out of date.
 *
 * It shows the biggest purchases in a period. Everything it needs is declared here:
 *   - the picker entry (title, description, group),
 *   - its size,
 *   - its settings (the dialog is built from `configFields`),
 *   - where its data comes from (the existing `/analytics/summary` endpoint).
 */
import { useMemo } from "react";
import { BarList } from "../components/charts/BarList";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { accountField, countField, periodField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  // CHANGE: a unique, permanent ID (lowercase letters, digits, dashes). It is saved with every
  // placed copy of the widget, so do not rename it later.
  id: "example-biggest-purchases",
  title: "Biggest purchases",
  description: "Your largest purchases in a period, from biggest down.",
  // One of: "Accounts", "Spending", "Budgets", "Activity", "Tools".
  group: "Spending",
  // Width is in columns (out of 12) and height in rows.
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 3 },
  // Set to true to include it in the dashboard a new user gets; `order` places it among the others.
  defaultEnabled: false,
  order: 200,
  // The widget's settings and their starting values. Every key here needs a matching field below.
  defaultConfig: { period: "this-month", accountId: "", topN: 5 },
  // The settings dialog is generated from these. `periodField` and `accountField` are ready-made.
  configFields: [periodField, accountField, countField("topN", "How many to show", 3, 15)],
  Component: function BiggestPurchases({ config }) {
    // `config` is already checked and complete, so no defensive code is needed here.
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);

    // CHANGE: fetch whatever you need. `useApi` reloads by itself after a sync finishes.
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        from: period.from,
        to: period.to,
        groupBy: "merchant",
        accountId: config.accountId,
        limit: config.topN,
      }),
    );
    const rows = (data?.rows ?? []).filter((r) => r.key !== "other" && r.spendingMinor > 0);

    // `WidgetState` handles the loading, error and empty cases the same way for every widget.
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && rows.length === 0}
        emptyText={`No purchases ${period.label}.`}
      >
        <BarList
          rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.spendingMinor }))}
          format={(n) => formatMinor(n, "USD")}
        />
      </WidgetState>
    );
  },
});
