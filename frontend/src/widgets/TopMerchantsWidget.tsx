import { useMemo } from "react";
import { BarList } from "../components/charts/BarList";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { accountField, countField, includeTransfersField, periodField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "top-merchants",
  title: "Top merchants",
  description: "The places you spent the most, in a period.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 60,
  defaultConfig: { period: "last-30-days", accountId: "", topN: 8, includeTransfers: false },
  configFields: [
    periodField,
    accountField,
    countField("topN", "Merchants to show", 3, 20),
    includeTransfersField,
  ],
  Component: function TopMerchants({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        from: period.from,
        to: period.to,
        groupBy: "merchant",
        accountId: config.accountId,
        includeTransfers: config.includeTransfers,
        limit: config.topN,
      }),
    );
    // "Other" is a total of the rest, not a merchant, so it is left out of a top-merchants list.
    const rows = (data?.rows ?? []).filter((r) => r.key !== "other" && r.spendingMinor > 0);

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && rows.length === 0}
        emptyText={`No spending ${period.label}.`}
      >
        <BarList
          rows={rows.map((r) => ({
            key: r.key,
            label: r.label,
            value: r.spendingMinor,
            note: `${r.count}×`,
          }))}
          format={(n) => formatMinor(n, "USD")}
        />
      </WidgetState>
    );
  },
});
