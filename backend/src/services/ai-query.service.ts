import type { AppDb } from "../db/client.js";
import { addDays, addMonths, firstOfMonth, isRealDate, lastOfMonth } from "../utils/dates.js";
import { summarize } from "./analytics.service.js";
import { budgetMonth } from "./budget.service.js";
import { cashForecast } from "./forecast.service.js";
import { netWorthSeries } from "./networth-series.service.js";
import { recurringReport } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";

export type FinancialIntent =
  | "top_spending"
  | "cash_forecast"
  | "budget_status"
  | "recurring_subscriptions"
  | "net_worth_trend";

export interface VisualizationSpec {
  type: "bar" | "line" | "metric_card" | "table";
  title: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  seriesName?: string;
}

export interface QueryPlan {
  intent: FinancialIntent;
  parameters: Record<string, any>;
  visualization: VisualizationSpec;
  narrativeTemplate: string;
}

export interface HydratedItem {
  label: string;
  valueMinor: number;
  valueFormatted: string;
  count?: number;
  color?: string | null;
  pct?: number;
}

export interface HydratedSeriesPoint {
  date: string;
  valueMinor: number;
  valueFormatted: string;
}

export interface HydratedSeries {
  key: string;
  label: string;
  points: HydratedSeriesPoint[];
}

export interface HydratedVisualization {
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

export interface HydratedQueryResult {
  privacy: {
    zeroDataShared: true;
    promptSentToModel?: string;
    modelUsed: string;
    localExecutionMs: number;
    privacyNotice: string;
  };
  plan: QueryPlan;
  narrative: string;
  visualization: HydratedVisualization;
  summary: Record<string, any>;
}

export function formatMinor(minor: number, currency = "USD"): string {
  const abs = Math.abs(minor);
  const dollars = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = minor < 0 ? "-" : "";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${prefix}${symbol}${dollars}`;
}

/**
 * Builds the zero-data prompt sent to the Gemini API.
 * CRITICAL PRIVACY GUARANTEE:
 * This prompt contains ONLY abstract schema information, current calendar anchor date,
 * and the user's natural language question. NO financial amounts, transactions,
 * balances, or account details are ever included.
 */
export function buildGeminiZeroDataPrompt(userQuery: string, today: string): string {
  return `You are a financial query compiler for a privacy-first personal finance application.
The application operates under a STRICT ZERO-KNOWLEDGE PRIVACY INVARIANT:
You will NEVER be given the user's personal financial numbers, balances, account details, or transaction data.
Your job is to translate the user's natural language question into an abstract local query plan and visualization spec.
The user's local device will execute the query locally against its encrypted SQLite database and hydrate all token placeholders.

CURRENT ANCHOR DATE (TODAY): "${today}"

SUPPORTED INTENTS:
1. "top_spending":
   - Description: Top spending breakdown by category or merchant over a time period.
   - Parameters:
     - "fromDate": "YYYY-MM-DD"
     - "toDate": "YYYY-MM-DD"
     - "groupBy": "category" | "merchant" (default "category")
     - "limit": number (e.g. 5)
   - Available Narrative Template Tokens:
     - {{top_name}}: Name of top category or merchant
     - {{top_amount}}: Amount spent on top category (e.g. $340.50)
     - {{top_count}}: Number of transactions in top category
     - {{top_pct}}: Percentage of total spending (e.g. 38%)
     - {{total_spending}}: Total money spent across all categories
     - {{from_date}}: Formatted start date
     - {{to_date}}: Formatted end date

2. "cash_forecast":
   - Description: Forward-looking cash projection in checking/cash accounts.
   - Parameters:
     - "days": number (e.g. 30, 60, 90)
     - "includeGoals": boolean (default true)
     - "includeBudget": boolean (default true)
   - Available Narrative Template Tokens:
     - {{start_balance}}: Current cash in bank today
     - {{end_balance}}: Projected cash balance at end of forecast
     - {{lowest_balance}}: Lowest projected balance in window
     - {{lowest_date}}: Date of lowest projected balance
     - {{days}}: Number of forecast days

3. "budget_status":
   - Description: Monthly budget progress, utilization, and remaining spending capacity.
   - Parameters:
     - "month": "YYYY-MM" (e.g. "${today.slice(0, 7)}")
   - Available Narrative Template Tokens:
     - {{month_label}}: Name of month (e.g. October 2026)
     - {{budgeted_amount}}: Total budgeted amount
     - {{spent_amount}}: Total spent so far
     - {{remaining_amount}}: Amount remaining in budget
     - {{pct_spent}}: Percentage of budget used

4. "recurring_subscriptions":
   - Description: Detected recurring subscriptions and bills.
   - Parameters:
     - "status": "active"
   - Available Narrative Template Tokens:
     - {{subscription_count}}: Number of recurring services
     - {{monthly_total}}: Total estimated cost per month

5. "net_worth_trend":
   - Description: Historical net worth trend over time.
   - Parameters:
     - "months": number (e.g. 6 or 12)
   - Available Narrative Template Tokens:
     - {{current_net_worth}}: Current net worth
     - {{months}}: Number of months

OUTPUT FORMAT REQUIREMENTS:
Respond with ONLY a valid, raw JSON object (no markdown code blocks, no backticks, no extra text) matching:
{
  "intent": "<intent_name>",
  "parameters": { ... },
  "visualization": {
    "type": "bar" | "line" | "metric_card" | "table",
    "title": "Clear concise chart title",
    "subtitle": "Short subtitle or date range",
    "xLabel": "Category / Date",
    "yLabel": "Amount ($)",
    "seriesName": "Spending / Balance"
  },
  "narrativeTemplate": "Markdown text with {{token_name}} placeholders explaining the answer clearly."
}

USER QUERY:
"${userQuery}"`;
}

/**
 * Calculates Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Typo-tolerant matcher: checks if target appears as a substring, or matches any word in text
 * within a small edit distance (1-2 characters).
 */
export function hasWordFuzzy(text: string, target: string, maxDistance = 2): boolean {
  if (text.includes(target)) return true;
  const words = text.split(/[\s,?.!/\\-]+/);
  const targetLen = target.length;
  const allowed = targetLen <= 4 ? 1 : maxDistance;

  for (const word of words) {
    if (Math.abs(word.length - targetLen) > allowed) continue;
    if (levenshtein(word, target) <= allowed) return true;
  }
  return false;
}

/**
 * Built-in local offline semantic query planner with fuzzy matching for typo tolerance.
 * Runs instantly with 0ms network latency and 100% offline privacy when Gemini API key
 * is not configured or network is unreachable.
 */
export function localSemanticPlanner(userQuery: string, today: string): QueryPlan {
  const q = userQuery.toLowerCase().trim();

  // 1. Cash Forecast (handles typos like "forcast", "foreacst", "runwy")
  if (
    hasWordFuzzy(q, "forecast") ||
    hasWordFuzzy(q, "runway") ||
    q.includes("cash balance") ||
    q.includes("bank account in") ||
    q.includes("going to go negative") ||
    q.includes("cash in")
  ) {
    let days = 60;
    const matchDays = q.match(/(\d+)\s*(day|days|dais)/);
    const matchWeeks = q.match(/(\d+)\s*(week|weeks|weks)/);
    const matchMonths = q.match(/(\d+)\s*(month|months|moths)/);

    if (matchDays) days = parseInt(matchDays[1], 10);
    else if (matchWeeks) days = parseInt(matchWeeks[1], 10) * 7;
    else if (matchMonths) days = parseInt(matchMonths[1], 10) * 30;

    days = Math.min(180, Math.max(7, days));

    return {
      intent: "cash_forecast",
      parameters: { days, includeGoals: true, includeBudget: true },
      visualization: {
        type: "line",
        title: `Cash-Flow Forecast (${days} Days)`,
        subtitle: `Projected cash balance from ${today} to ${addDays(today, days)}`,
        xLabel: "Date",
        yLabel: "Cash Balance",
        seriesName: "Projected Cash",
      },
      narrativeTemplate:
        "Over the next {{days}} days, your bank cash balance begins at **{{start_balance}}** today and is projected to end at **{{end_balance}}**. Your lowest projected cash balance is **{{lowest_balance}}** on {{lowest_date}}.",
    };
  }

  // 2. Budget status (handles typos like "bugdet", "budgt", "allownace")
  if (
    hasWordFuzzy(q, "budget") ||
    hasWordFuzzy(q, "budgets") ||
    hasWordFuzzy(q, "allowance") ||
    hasWordFuzzy(q, "overspend")
  ) {
    const month = today.slice(0, 7);
    return {
      intent: "budget_status",
      parameters: { month },
      visualization: {
        type: "bar",
        title: `Monthly Budget Status (${month})`,
        subtitle: "Budgeted vs actual spending by category",
        xLabel: "Category",
        yLabel: "Amount",
        seriesName: "Spent",
      },
      narrativeTemplate:
        "For {{month_label}}, you have spent **{{spent_amount}}** of your **{{budgeted_amount}}** budget ({{pct_spent}}% utilized), leaving **{{remaining_amount}}** to spend across the rest of the month.",
    };
  }

  // 3. Recurring Subscriptions (handles typos like "subcription", "subscripton", "recurrng")
  if (
    hasWordFuzzy(q, "subscription") ||
    hasWordFuzzy(q, "subscriptions") ||
    hasWordFuzzy(q, "recurring") ||
    q.includes("monthly bill") ||
    q.includes("streaming")
  ) {
    return {
      intent: "recurring_subscriptions",
      parameters: { status: "active" },
      visualization: {
        type: "table",
        title: "Active Recurring Subscriptions",
        subtitle: "Found regular bills and subscription services",
      },
      narrativeTemplate:
        "You currently have **{{subscription_count}}** active recurring subscriptions totaling approximately **{{monthly_total}}/month** (about **{{yearly_total}}/year**).",
    };
  }

  // 4. Net worth trend (handles "networth", "net-worth", "welth")
  if (
    hasWordFuzzy(q, "networth") ||
    q.includes("net worth") ||
    hasWordFuzzy(q, "wealth") ||
    q.includes("assets minus")
  ) {
    let months = 6;
    const matchMonths = q.match(/(\d+)\s*(month|months|year|years)/);
    if (matchMonths) {
      if (matchMonths[2].startsWith("year")) months = parseInt(matchMonths[1], 10) * 12;
      else months = parseInt(matchMonths[1], 10);
    }
    months = Math.min(36, Math.max(1, months));

    return {
      intent: "net_worth_trend",
      parameters: { months },
      visualization: {
        type: "line",
        title: `Net Worth Trend (${months} Months)`,
        subtitle: "Historical tracked assets and debts",
        xLabel: "Month",
        yLabel: "Net Worth",
        seriesName: "Net Worth",
      },
      narrativeTemplate:
        "Your total net worth is currently **{{current_net_worth}}**, reflecting your total cash, investments, and card debts combined.",
    };
  }

  // 5. Default: Top spending (handles typos like "spnding", "expnses", "categori", "weks")
  let days = 14;
  let periodDesc = "past 2 weeks";

  const isOneWeek =
    (hasWordFuzzy(q, "week") && !q.includes("2") && !q.includes("two")) ||
    q.includes("7 day");
  const isTwoWeeks =
    q.includes("2 week") ||
    q.includes("two week") ||
    q.includes("14 day") ||
    hasWordFuzzy(q, "fortnight") ||
    hasWordFuzzy(q, "weks");

  if (isTwoWeeks) {
    days = 14;
    periodDesc = "past 2 weeks";
  } else if (isOneWeek) {
    days = 7;
    periodDesc = "past 7 days";
  } else if (hasWordFuzzy(q, "month") || q.includes("30 day")) {
    days = 30;
    periodDesc = "past 30 days";
  } else if (hasWordFuzzy(q, "year") || q.includes("365 day")) {
    days = 365;
    periodDesc = "past year";
  } else {
    const matchDays = q.match(/(\d+)\s*(day|days|dais)/);
    if (matchDays) {
      days = parseInt(matchDays[1], 10);
      periodDesc = `past ${days} days`;
    }
  }

  const groupBy: "category" | "merchant" =
    hasWordFuzzy(q, "merchant") || hasWordFuzzy(q, "merchants") || hasWordFuzzy(q, "store") || hasWordFuzzy(q, "place")
      ? "merchant"
      : "category";

  const fromDate = addDays(today, -days);
  const toDate = today;

  return {
    intent: "top_spending",
    parameters: {
      fromDate,
      toDate,
      groupBy,
      limit: 5,
      periodDesc,
    },
    visualization: {
      type: "bar",
      title: `Top Spending by ${groupBy === "merchant" ? "Merchant" : "Category"} (${periodDesc})`,
      subtitle: `${fromDate} to ${toDate}`,
      xLabel: groupBy === "merchant" ? "Merchant" : "Category",
      yLabel: "Spending",
      seriesName: "Spending",
    },
    narrativeTemplate:
      `In the ${periodDesc} (from {{from_date}} to {{to_date}}), your top spending ${groupBy === "merchant" ? "merchant" : "category"} was **{{top_name}}** with **{{top_amount}}** spent across {{top_count}} transactions, representing **{{top_pct}}%** of your total spending of {{total_spending}}.`,
  };
}

/**
 * Calls Gemini API if an API key is provided, falling back cleanly to the local semantic planner.
 * Guarantees zero financial data is passed.
 */
export async function planQueryWithGemini(
  prompt: string,
  today: string,
  apiKey?: string,
): Promise<{ plan: QueryPlan; modelUsed: string; promptSent?: string }> {
  if (!apiKey || apiKey.trim() === "") {
    return {
      plan: localSemanticPlanner(prompt, today),
      modelUsed: "local-semantic-planner (offline)",
    };
  }

  const promptText = buildGeminiZeroDataPrompt(prompt, today);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey.trim(),
    )}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    });

    if (!res.ok) {
      console.warn(`Gemini API HTTP ${res.status}, falling back to local query planner`);
      return {
        plan: localSemanticPlanner(prompt, today),
        modelUsed: `local-semantic-planner (gemini-error-${res.status})`,
        promptSent: promptText,
      };
    }

    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Empty response from Gemini API");
    }

    const parsed = JSON.parse(text) as QueryPlan;
    if (!parsed.intent || !parsed.parameters || !parsed.visualization || !parsed.narrativeTemplate) {
      throw new Error("Invalid plan schema from Gemini API");
    }

    return {
      plan: parsed,
      modelUsed: "gemini-2.5-flash",
      promptSent: promptText,
    };
  } catch (err) {
    console.warn("Gemini call failed, falling back to local semantic planner:", err);
    return {
      plan: localSemanticPlanner(prompt, today),
      modelUsed: "local-semantic-planner (offline-fallback)",
      promptSent: promptText,
    };
  }
}

/**
 * Executes a QueryPlan locally inside the encrypted database with zero remote exposure,
 * hydrates all template tokens with exact computed numbers, and returns formatted visualizations.
 */
export function executeLocalPlan(
  db: AppDb,
  plan: QueryPlan,
  today: string,
  environment: string,
): {
  narrative: string;
  visualization: HydratedVisualization;
  summary: Record<string, any>;
} {
  const currency = getSettings(db).currency || "USD";

  switch (plan.intent) {
    case "top_spending": {
      const from = plan.parameters.fromDate || addDays(today, -14);
      const to = plan.parameters.toDate || today;
      const groupBy = (plan.parameters.groupBy as "category" | "merchant") || "category";
      const limit = plan.parameters.limit || 5;

      const summary = summarize(db, {
        from,
        to,
        groupBy,
        includeTransfers: false,
        includePending: true,
        fill: false,
        environment,
      });

      const totalSpending = summary.totals.spendingMinor;
      const sortedRows = [...summary.rows]
        .filter((r) => r.spendingMinor > 0)
        .sort((a, b) => b.spendingMinor - a.spendingMinor);

      const top = sortedRows[0] || {
        key: "none",
        label: "None",
        spendingMinor: 0,
        count: 0,
        color: null,
      };

      const topPct = totalSpending > 0 ? Math.round((top.spendingMinor / totalSpending) * 100) : 0;

      const items: HydratedItem[] = sortedRows.slice(0, limit).map((r) => ({
        label: r.label,
        valueMinor: r.spendingMinor,
        valueFormatted: formatMinor(r.spendingMinor, currency),
        count: r.count,
        color: r.color,
        pct: totalSpending > 0 ? Math.round((r.spendingMinor / totalSpending) * 100) : 0,
      }));

      const tokens: Record<string, string> = {
        "{{top_name}}": top.label,
        "{{top_category_name}}": top.label,
        "{{top_amount}}": formatMinor(top.spendingMinor, currency),
        "{{top_category_amount}}": formatMinor(top.spendingMinor, currency),
        "{{top_count}}": String(top.count),
        "{{top_category_count}}": String(top.count),
        "{{top_pct}}": `${topPct}`,
        "{{top_category_share}}": `${topPct}`,
        "{{total_spending}}": formatMinor(totalSpending, currency),
        "{{from_date}}": from,
        "{{fromDate}}": from,
        "{{to_date}}": to,
        "{{toDate}}": to,
        "{{period_description}}": plan.parameters.periodDesc || "period",
      };

      let narrative = plan.narrativeTemplate;
      for (const [k, v] of Object.entries(tokens)) {
        narrative = narrative.split(k).join(v);
      }

      return {
        narrative,
        visualization: {
          type: plan.visualization.type || "bar",
          title: plan.visualization.title,
          subtitle: plan.visualization.subtitle,
          items,
        },
        summary: {
          from,
          to,
          totalSpendingMinor: totalSpending,
          topCategory: top.label,
          topSpendingMinor: top.spendingMinor,
          itemCount: items.length,
        },
      };
    }

    case "cash_forecast": {
      const days = plan.parameters.days || 60;
      const forecast = cashForecast(db, {
        today,
        days,
        includeGoals: plan.parameters.includeGoals ?? true,
        includeBudget: plan.parameters.includeBudget ?? true,
      });

      const seriesPoints: HydratedSeriesPoint[] = forecast.days.map((d) => ({
        date: d.date,
        valueMinor: d.balanceMinor,
        valueFormatted: formatMinor(d.balanceMinor, currency),
      }));

      const tokens: Record<string, string> = {
        "{{start_balance}}": formatMinor(forecast.startBalanceMinor, currency),
        "{{end_balance}}": formatMinor(forecast.endBalanceMinor, currency),
        "{{lowest_balance}}": formatMinor(forecast.lowest.balanceMinor, currency),
        "{{lowest_date}}": forecast.lowest.date,
        "{{days}}": String(days),
      };

      let narrative = plan.narrativeTemplate;
      for (const [k, v] of Object.entries(tokens)) {
        narrative = narrative.split(k).join(v);
      }

      return {
        narrative,
        visualization: {
          type: "line",
          title: plan.visualization.title || `Cash-Flow Forecast (${days} Days)`,
          subtitle: plan.visualization.subtitle,
          series: [
            {
              key: "balance",
              label: "Cash Balance",
              points: seriesPoints,
            },
          ],
        },
        summary: {
          startBalanceMinor: forecast.startBalanceMinor,
          endBalanceMinor: forecast.endBalanceMinor,
          lowestBalanceMinor: forecast.lowest.balanceMinor,
          lowestDate: forecast.lowest.date,
        },
      };
    }

    case "budget_status": {
      const month = plan.parameters.month || today.slice(0, 7);
      const bMonth = budgetMonth(db, month, environment);

      const budgeted = bMonth.totals.budgetedMinor;
      const spent = bMonth.totals.spentMinor;
      const remaining = bMonth.totals.remainingMinor;
      const pctSpent = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0;

      const items: HydratedItem[] = bMonth.budgets.slice(0, 8).map((b) => ({
        label: b.categoryName,
        valueMinor: b.spentMinor,
        valueFormatted: formatMinor(b.spentMinor, currency),
        color: b.categoryColor,
        pct: b.availableMinor > 0 ? Math.round((b.spentMinor / b.availableMinor) * 100) : 0,
      }));

      const tokens: Record<string, string> = {
        "{{month_label}}": month,
        "{{budgeted_amount}}": formatMinor(budgeted, currency),
        "{{spent_amount}}": formatMinor(spent, currency),
        "{{remaining_amount}}": formatMinor(remaining, currency),
        "{{pct_spent}}": `${pctSpent}`,
      };

      let narrative = plan.narrativeTemplate;
      for (const [k, v] of Object.entries(tokens)) {
        narrative = narrative.split(k).join(v);
      }

      return {
        narrative,
        visualization: {
          type: "bar",
          title: plan.visualization.title || `Budget Status (${month})`,
          subtitle: plan.visualization.subtitle,
          items,
        },
        summary: {
          month,
          budgetedMinor: budgeted,
          spentMinor: spent,
          remainingMinor: remaining,
          pctSpent,
        },
      };
    }

    case "recurring_subscriptions": {
      const report = recurringReport(db, { today });
      const series = report.series.filter((s) => s.active);

      const monthlyTotal = series.reduce((sum, s) => sum + s.typicalMinor, 0);
      const yearlyTotal = monthlyTotal * 12;

      const items: HydratedItem[] = series.map((s) => ({
        label: s.merchant,
        valueMinor: s.typicalMinor,
        valueFormatted: formatMinor(s.typicalMinor, currency),
        count: s.occurrences,
      }));

      const tokens: Record<string, string> = {
        "{{subscription_count}}": String(series.length),
        "{{monthly_total}}": formatMinor(monthlyTotal, currency),
        "{{yearly_total}}": formatMinor(yearlyTotal, currency),
      };

      let narrative = plan.narrativeTemplate;
      for (const [k, v] of Object.entries(tokens)) {
        narrative = narrative.split(k).join(v);
      }

      return {
        narrative,
        visualization: {
          type: items.length > 0 ? "table" : "metric_card",
          title: plan.visualization.title || "Recurring Subscriptions",
          subtitle: plan.visualization.subtitle,
          items,
          metric: {
            primary: formatMinor(monthlyTotal, currency),
            label: "Total Monthly Subscriptions",
            secondary: `${series.length} active recurring services`,
          },
        },
        summary: {
          subscriptionCount: series.length,
          monthlyTotalMinor: monthlyTotal,
          yearlyTotalMinor: yearlyTotal,
        },
      };
    }

    case "net_worth_trend": {
      const months = plan.parameters.months || 6;
      const from = `${addMonths(today.slice(0, 7), -months)}-01`;
      const series = netWorthSeries(db, {
        granularity: "month",
        from,
        to: today,
        today,
      });

      const points = series.points;
      const latestPoint = points[points.length - 1];
      const currentNetWorthMinor = latestPoint ? latestPoint.netWorthMinor : 0;

      const seriesPoints: HydratedSeriesPoint[] = points.map((p) => ({
        date: p.date,
        valueMinor: p.netWorthMinor,
        valueFormatted: formatMinor(p.netWorthMinor, currency),
      }));

      const tokens: Record<string, string> = {
        "{{current_net_worth}}": formatMinor(currentNetWorthMinor, currency),
        "{{months}}": String(months),
      };

      let narrative = plan.narrativeTemplate;
      for (const [k, v] of Object.entries(tokens)) {
        narrative = narrative.split(k).join(v);
      }

      return {
        narrative,
        visualization: {
          type: "line",
          title: plan.visualization.title || `Net Worth Trend (${months} Months)`,
          subtitle: plan.visualization.subtitle,
          series: [
            {
              key: "net_worth",
              label: "Net Worth",
              points: seriesPoints,
            },
          ],
          metric: {
            primary: formatMinor(currentNetWorthMinor, currency),
            label: "Current Net Worth",
          },
        },
        summary: {
          currentNetWorthMinor,
          months,
          pointCount: seriesPoints.length,
        },
      };
    }

    default:
      throw new Error(`Unsupported intent: ${(plan as any).intent}`);
  }
}

/**
 * End-to-end zero-data query execution.
 */
export async function askFinancialAssistant(
  db: AppDb,
  userQuery: string,
  options: { today?: string } = {},
): Promise<HydratedQueryResult> {
  const startTime = Date.now();
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new Error("Invalid anchor date");

  const settings = getSettings(db);
  const { plan, modelUsed, promptSent } = await planQueryWithGemini(
    userQuery,
    today,
    settings.geminiApiKey,
  );

  const { narrative, visualization, summary } = executeLocalPlan(
    db,
    plan,
    today,
    settings.plaidEnvironment,
  );

  const localExecutionMs = Date.now() - startTime;

  return {
    privacy: {
      zeroDataShared: true,
      promptSentToModel: promptSent,
      modelUsed,
      localExecutionMs,
      privacyNotice:
        "Zero personal financial data, account numbers, or transaction logs were transmitted to any external model. The query plan was compiled using abstract schema metadata, and all data was queried and hydrated locally from your encrypted SQLite database.",
    },
    plan,
    narrative,
    visualization,
    summary,
  };
}
