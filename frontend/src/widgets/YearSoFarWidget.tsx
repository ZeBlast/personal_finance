import { Link } from "react-router-dom";
import { YearMonthsTable } from "../components/views/YearMonthsTable";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import type { YearReport } from "../pages/YearPage";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "year-so-far",
  title: "The year so far",
  description: "Each month of this year side by side: money in, money out, and what was saved.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 66,
  Component: function YearSoFar() {
    const day = today();
    const { data, error, loading } = useApi<YearReport>(
      `/reports/year?year=${day.slice(0, 4)}&today=${day}`,
    );
    const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
    return (
      <WidgetState loading={loading} error={error}>
        {data && (
          <>
            <YearMonthsTable months={data.months} money={money} compact />
            <Link to="/reports/year" className="mt-2 inline-block text-xs text-blue-600 underline">
              See the whole year
            </Link>
          </>
        )}
      </WidgetState>
    );
  },
});
