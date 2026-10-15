import { useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import type { ReviewQueue } from "../types/planning";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** What the Review tab has waiting: transactions worth a look, and ones with no category. */
export default defineWidget({
  id: "review-queue",
  title: "To review",
  description:
    "How many recent transactions are worth a look and how many have no category, with a link to the Review tab.",
  group: "Activity",
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  order: 480,
  singleton: true,
  Component: function ToReview() {
    const navigate = useNavigate();
    const queue = useApi<ReviewQueue>("/review");
    const loose = useApi<{ total: number }>("/review/uncategorized");
    const tiles = [
      { label: "Worth a look", value: queue.data?.items.length ?? 0, tone: "text-amber-600" },
      { label: "No category", value: loose.data?.total ?? 0, tone: "text-blue-600" },
    ];
    return (
      <WidgetState loading={queue.loading || loose.loading} error={queue.error ?? loose.error}>
        <button
          type="button"
          onClick={() => navigate("/transactions/review")}
          title="Open the Review tab"
          className="grid h-full w-full grid-cols-2 gap-2 rounded-md text-left hover:bg-slate-50 dark:hover:bg-slate-700/50"
        >
          {tiles.map((t) => (
            <span key={t.label} className="flex flex-col justify-center px-1">
              <span
                className={`text-3xl font-semibold tabular-nums ${t.value > 0 ? t.tone : "text-slate-400"}`}
              >
                {t.value}
              </span>
              <span className="text-xs text-slate-500">{t.label}</span>
            </span>
          ))}
        </button>
      </WidgetState>
    );
  },
});
