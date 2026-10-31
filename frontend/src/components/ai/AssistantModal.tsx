import { useState, type FormEvent } from "react";
import {
  Sparkles,
  ShieldCheck,
  Send,
  X,
  ChevronDown,
  ChevronUp,
  BarChart3,
  TrendingUp,
  CreditCard,
  Lock,
} from "lucide-react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";

interface AiStatus {
  configured: boolean;
  hasGeminiKey: boolean;
  model: string;
  zeroDataGuarantee: boolean;
  privacyGuarantee: string;
  suggestions: string[];
}

interface HydratedItem {
  label: string;
  valueMinor: number;
  valueFormatted: string;
  count?: number;
  color?: string | null;
  pct?: number;
}

interface HydratedSeriesPoint {
  date: string;
  valueMinor: number;
  valueFormatted: string;
}

interface HydratedSeries {
  key: string;
  label: string;
  points: HydratedSeriesPoint[];
}

interface HydratedVisualization {
  type: "bar" | "line" | "metric_card" | "table";
  title: string;
  subtitle?: string;
  items?: HydratedItem[];
  series?: HydratedSeries[];
  metric?: {
    primary: string;
    label: string;
    secondary?: string;
  };
}

interface HydratedQueryResult {
  privacy: {
    zeroDataShared: true;
    promptSentToModel?: string;
    modelUsed: string;
    localExecutionMs: number;
    privacyNotice: string;
  };
  plan: {
    intent: string;
    parameters: Record<string, any>;
    visualization: {
      type: string;
      title: string;
    };
    narrativeTemplate: string;
  };
  narrative: string;
  visualization: HydratedVisualization;
  summary: Record<string, any>;
}

export function AssistantModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: status } = useApi<AiStatus>("/ai/status");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HydratedQueryResult | null>(null);
  const [showPrivacyAudit, setShowPrivacyAudit] = useState(false);

  if (!open) return null;

  async function submitQuery(queryText: string): Promise<void> {
    const q = queryText.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    try {
      const res = await api<HydratedQueryResult>("/ai/ask", {
        method: "POST",
        body: JSON.stringify({ prompt: q }),
      });
      setResult(res);
      setPrompt("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    void submitQuery(prompt);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-slate-900 dark:border dark:border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 p-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-blue-500 text-white shadow-md shadow-indigo-500/20">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Financial Assistant
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300">
                  <Lock className="h-3 w-3" />
                  Zero Data Shared
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Powered by {status?.model ?? "Gemini"} · Schema planned remotely, data resolved locally
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close assistant"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Privacy Banner */}
          <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/50 p-3 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200">
            <div className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
              <div>
                <span className="font-semibold">Zero-Knowledge Financial Guarantee:</span> Your
                transaction amounts, account balances, and merchant records are never sent over the
                network. The model translates your question into an abstract query template, and all
                financial data is calculated locally inside your encrypted SQLite database.
              </div>
            </div>
          </div>

          {/* Prompt Suggestions */}
          {!result && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Suggested questions:
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  "Show me my top spending category in the past 2 weeks",
                  "What is my cash forecast for the next 60 days?",
                  "How is my monthly budget tracking?",
                  "What recurring subscriptions am I paying for?",
                  "Show my net worth trend over the last 6 months",
                ].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void submitQuery(s)}
                    disabled={loading}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-indigo-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Loading Indicator */}
          {loading && (
            <div className="flex items-center justify-center gap-3 py-10 text-sm text-slate-500">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              <span>Planning query schema & calculating encrypted local records...</span>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-300"
            >
              {error}
            </div>
          )}

          {/* Query Result View */}
          {result && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Narrative Answer Box */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-200">
                <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                  <Sparkles className="h-3.5 w-3.5" />
                  Insight Summary
                </div>
                <div
                  className="prose prose-sm dark:prose-invert"
                  dangerouslySetInnerHTML={{
                    __html: result.narrative
                      .replace(/\*\*(.*?)\*\*/g, '<strong class="text-indigo-700 dark:text-indigo-300 font-semibold">$1</strong>')
                      .replace(/\n/g, "<br/>"),
                  }}
                />
              </div>

              {/* Dynamic Visualization */}
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {result.visualization.title}
                    </h3>
                    {result.visualization.subtitle && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {result.visualization.subtitle}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-slate-400">
                    {result.visualization.type === "bar" && <BarChart3 className="h-4 w-4" />}
                    {result.visualization.type === "line" && <TrendingUp className="h-4 w-4" />}
                    {result.visualization.type === "table" && <CreditCard className="h-4 w-4" />}
                  </span>
                </div>

                {/* Bar Chart Visualization */}
                {result.visualization.type === "bar" && result.visualization.items && (
                  <div className="space-y-2.5">
                    {result.visualization.items.map((item, idx) => (
                      <div key={item.label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {idx + 1}. {item.label}
                            {item.count ? (
                              <span className="ml-1 text-[11px] text-slate-400">
                                ({item.count} txns)
                              </span>
                            ) : null}
                          </span>
                          <div className="flex items-center gap-2">
                            {item.pct !== undefined && (
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                                {item.pct}%
                              </span>
                            )}
                            <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                              {item.valueFormatted}
                            </span>
                          </div>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-500 transition-all duration-500"
                            style={{
                              width: `${Math.max(4, Math.min(100, item.pct ?? (item.valueMinor / (result.visualization.items![0]?.valueMinor || 1)) * 100))}%`,
                              backgroundColor: item.color || undefined,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Line Chart Visualization */}
                {result.visualization.type === "line" && result.visualization.series?.[0] && (
                  <div className="py-2">
                    <div className="h-36 w-full flex items-end gap-1 border-b border-l border-slate-200 p-2 dark:border-slate-700">
                      {result.visualization.series[0].points.map((pt, _idx, arr) => {
                        const values = arr.map((p) => p.valueMinor);
                        const min = Math.min(...values);
                        const max = Math.max(...values);
                        const range = Math.max(1, max - min);
                        const heightPct = Math.round(((pt.valueMinor - min) / range) * 80) + 10;

                        return (
                          <div
                            key={pt.date}
                            className="group relative flex-1 h-full flex flex-col justify-end items-center"
                          >
                            <div
                              className="w-full rounded-t bg-indigo-500/70 hover:bg-indigo-600 transition-all group-hover:scale-y-105"
                              style={{ height: `${heightPct}%` }}
                            />
                            {/* Hover tooltip */}
                            <div className="pointer-events-none absolute -top-8 z-10 hidden rounded bg-slate-900 px-2 py-1 text-[10px] text-white shadow group-hover:block dark:bg-slate-100 dark:text-slate-900 whitespace-nowrap">
                              {pt.date}: {pt.valueFormatted}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-slate-400">
                      <span>{result.visualization.series[0].points[0]?.date}</span>
                      <span>
                        {
                          result.visualization.series[0].points[
                            result.visualization.series[0].points.length - 1
                          ]?.date
                        }
                      </span>
                    </div>
                  </div>
                )}

                {/* Table Visualization */}
                {result.visualization.type === "table" && result.visualization.items && (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    {result.visualization.items.map((item) => (
                      <div key={item.label} className="flex items-center justify-between py-2">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {item.label}
                        </span>
                        <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {item.valueFormatted}/mo
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Privacy Proof & Telemetry Accordion */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowPrivacyAudit((prev) => !prev)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50"
                >
                  <span className="flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    Privacy Verification Proof (Local Execution: {result.privacy.localExecutionMs}ms)
                  </span>
                  {showPrivacyAudit ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {showPrivacyAudit && (
                  <div className="border-t border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900/80 space-y-2">
                    <p className="text-slate-600 dark:text-slate-300">
                      <strong>Audit Trail:</strong> Below is the exact schema prompt passed to the
                      AI model. Notice that <em>no balances, no transaction logs, and no account IDs</em> were included.
                    </p>
                    <pre className="max-h-40 overflow-y-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-300">
                      {result.privacy.promptSentToModel ?? "Generated offline using built-in Local Semantic Planner (0 network bytes sent)."}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Input Footer */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-slate-100 p-3 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 rounded-b-2xl"
        >
          <div className="relative flex items-center">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask anything (e.g. 'show me my top spending category in the past 2 weeks')..."
              disabled={loading}
              className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-3 pr-10 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              className="absolute right-2 rounded-lg bg-indigo-600 p-1.5 text-white hover:bg-indigo-700 disabled:opacity-40 transition-opacity"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
