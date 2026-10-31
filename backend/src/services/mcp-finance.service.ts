import type { AppDb } from "../db/client.js";
import {
  askFinancialAssistant,
  executeLocalPlan,
  localSemanticPlanner,
  type FinancialIntent,
  type HydratedQueryResult,
  type QueryPlan,
} from "./ai-query.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Model Context Protocol (MCP) Server & Tool Adapter for Personal Finance.
 *
 * Implements the "Opaque Dataset Reference Pattern":
 * When an external LLM agent (via MCP) interacts with financial tools,
 * raw personal records are never passed back into the context window.
 * Instead, the tool returns an ephemeral `dataset_id`, aggregated summary tokens,
 * and a declarative visualization specification. The client application's UI
 * renders the generative UI widget or chart locally with complete privacy.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface OpaqueDatasetHandle {
  datasetId: string;
  intent: FinancialIntent;
  rowCount: number;
  schema: string[];
  summaryTokens: Record<string, string>;
  createdAt: string;
}

// In-memory dataset registry for opaque handles
const opaqueDatasets = new Map<string, { handle: OpaqueDatasetHandle; rawResult: HydratedQueryResult }>();

export function listFinancialMcpTools(): McpToolDefinition[] {
  return [
    {
      name: "finance_ask",
      description:
        "Answers natural-language financial queries (e.g. 'show me my top spending category in the past 2 weeks') with guaranteed zero-data leakage to external models. Returns hydrated narrative and visualization specifications.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The user's natural language question (e.g. 'top spending in the past 2 weeks').",
          },
          today: {
            type: "string",
            description: "Optional anchor date in YYYY-MM-DD format. Defaults to current date.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "finance_plan_query",
      description:
        "Compiles a natural language question into an abstract query plan and visualization spec without querying the database or inspecting financial records.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query to compile.",
          },
          today: {
            type: "string",
            description: "Optional anchor date in YYYY-MM-DD format.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "finance_execute_private_plan",
      description:
        "Executes a compiled query plan locally against the encrypted database, stores results behind an opaque dataset handle, and returns narrative tokens without leaking raw transactions to the context window.",
      inputSchema: {
        type: "object",
        properties: {
          plan: {
            type: "object",
            description: "The QueryPlan to execute locally.",
          },
          today: {
            type: "string",
            description: "Optional anchor date in YYYY-MM-DD format.",
          },
        },
        required: ["plan"],
      },
    },
    {
      name: "finance_list_capabilities",
      description:
        "Lists supported financial analytical intents, date intervals, and visualization types available in the local application engine.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

export async function executeFinancialMcpTool(
  db: AppDb,
  toolName: string,
  args: Record<string, any>,
): Promise<any> {
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const settings = getSettings(db);

  switch (toolName) {
    case "finance_ask": {
      const query = String(args.query ?? "");
      return await askFinancialAssistant(db, query, { today });
    }

    case "finance_plan_query": {
      const query = String(args.query ?? "");
      return localSemanticPlanner(query, today);
    }

    case "finance_execute_private_plan": {
      const plan = args.plan as QueryPlan;
      const result = executeLocalPlan(db, plan, today, settings.plaidEnvironment);
      const datasetId = `ds_${Math.random().toString(36).slice(2, 10)}`;

      const handle: OpaqueDatasetHandle = {
        datasetId,
        intent: plan.intent,
        rowCount: result.visualization.items?.length ?? result.visualization.series?.[0]?.points.length ?? 0,
        schema: plan.intent === "top_spending" ? ["category", "amount_minor", "pct"] : ["date", "balance_minor"],
        summaryTokens: {
          narrative: result.narrative,
          title: result.visualization.title,
        },
        createdAt: new Date().toISOString(),
      };

      opaqueDatasets.set(datasetId, {
        handle,
        rawResult: {
          privacy: {
            zeroDataShared: true,
            modelUsed: "local-mcp-executor",
            localExecutionMs: 0,
            privacyNotice: "Zero data passed to model context via Opaque Dataset Handle.",
          },
          plan,
          narrative: result.narrative,
          visualization: result.visualization,
          summary: result.summary,
        },
      });

      return {
        opaqueDataset: handle,
        narrative: result.narrative,
        visualizationSpec: {
          type: result.visualization.type,
          title: result.visualization.title,
          subtitle: result.visualization.subtitle,
          datasetId,
        },
        privacyGuarantee: "No raw financial data was returned to the model context.",
      };
    }

    case "finance_list_capabilities": {
      return {
        intents: [
          {
            name: "top_spending",
            description: "Breakdown of top spending categories or merchants over a chosen time period.",
            examples: [
              "show me my top spending category in the past 2 weeks",
              "top merchant spending this month",
            ],
          },
          {
            name: "cash_forecast",
            description: "Forward-looking checking/savings cash balance projection with goal and budget options.",
            examples: ["show me my cash forecast for next 60 days", "project cash runway for 30 days"],
          },
          {
            name: "budget_status",
            description: "Current month budget limits, spending burn, and remaining allowance.",
            examples: ["how is my budget doing this month", "budget status for october"],
          },
          {
            name: "recurring_subscriptions",
            description: "Active subscriptions and recurring charges detected in transactions.",
            examples: ["what subscriptions am i paying for", "list my monthly recurring bills"],
          },
          {
            name: "net_worth_trend",
            description: "Historical trend of net worth across assets and liabilities.",
            examples: ["show my net worth trend over 6 months"],
          },
        ],
        visualizations: ["bar", "line", "metric_card", "table"],
        privacyInvariant: "Zero-Knowledge Query Planner with Local Private Hydration",
      };
    }

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
