import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type AppDb } from "./db/client.js";
import {
  askFinancialAssistant,
  buildGeminiZeroDataPrompt,
  executeLocalPlan,
  localSemanticPlanner,
} from "./services/ai-query.service.js";
import { cashForecast } from "./services/forecast.service.js";
import { createGoal } from "./services/goal.service.js";
import { createBudget } from "./services/budget.service.js";
import { executeFinancialMcpTool, listFinancialMcpTools } from "./services/mcp-finance.service.js";
import { createManualBankAccount, createManualTransaction } from "./services/manual-transaction.service.js";
import { createCategory } from "./services/category.service.js";
import { TEST_DB_KEY } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle/migrations");

function setupTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ai-test-"));
  const { db, sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
  runMigrations(db, MIGRATIONS);
  cleanups.push(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

describe("Privacy Invariant: Zero-Data Gemini Prompt", () => {
  it("never includes transaction amounts, balances, or user PII in prompt", () => {
    const today = "2026-10-31";
    const prompt = buildGeminiZeroDataPrompt(
      "show me my top spending category in the past 2 weeks",
      today,
    );

    // Verifies schema-only instructions
    expect(prompt).toContain("ZERO-KNOWLEDGE PRIVACY INVARIANT");
    expect(prompt).toContain("CURRENT ANCHOR DATE (TODAY): \"2026-10-31\"");
    expect(prompt).toContain("top_spending");
    expect(prompt).toContain("{{top_name}}");
    expect(prompt).toContain("{{top_amount}}");

    // Must NOT contain personal finance figures or mock accounts
    expect(prompt).not.toContain("Chase");
    expect(prompt).not.toContain("Checking Balance");
    expect(prompt).not.toContain("transaction_id");
  });
});

describe("Local Semantic Planner (Offline Fallback)", () => {
  const today = "2026-10-31";

  it("plans top spending query for past 2 weeks correctly", () => {
    const plan = localSemanticPlanner("show me my top spending category in the past 2 weeks", today);

    expect(plan.intent).toBe("top_spending");
    expect(plan.parameters.groupBy).toBe("category");
    expect(plan.parameters.fromDate).toBe("2026-10-17");
    expect(plan.parameters.toDate).toBe("2026-10-31");
    expect(plan.visualization.type).toBe("bar");
    expect(plan.narrativeTemplate).toContain("{{top_name}}");
  });

  it("plans cash forecast query", () => {
    const plan = localSemanticPlanner("what is my cash forecast for next 60 days?", today);

    expect(plan.intent).toBe("cash_forecast");
    expect(plan.parameters.days).toBe(60);
    expect(plan.visualization.type).toBe("line");
  });

  it("plans budget status query", () => {
    const plan = localSemanticPlanner("how is my budget doing this month?", today);

    expect(plan.intent).toBe("budget_status");
    expect(plan.parameters.month).toBe("2026-10");
  });

  it("plans recurring subscriptions query", () => {
    const plan = localSemanticPlanner("what recurring subscriptions am I paying for?", today);

    expect(plan.intent).toBe("recurring_subscriptions");
  });
});

describe("End-to-End Local Execution & Hydration", () => {
  it("computes top spending category and hydrates template with zero data leakage", async () => {
    const db = setupTestDb();
    const today = "2026-10-31";

    const checkingId = createManualBankAccount(
      db,
      { name: "Checking", kind: "checking", openingBalanceMinor: 500_000 },
      new Date().toISOString(),
    );

    const foodCat = createCategory(db, { name: "Food & Dining" });
    const shoppingCat = createCategory(db, { name: "Shopping" });

    // Transactions in the last 2 weeks
    const now = new Date().toISOString();
    createManualTransaction(
      db,
      {
        accountId: checkingId,
        date: "2026-10-20",
        amountMinor: 15_000, // $150.00
        direction: "out",
        merchant: "Supermarket",
        categoryId: foodCat.id,
      },
      now,
    );
    createManualTransaction(
      db,
      {
        accountId: checkingId,
        date: "2026-10-25",
        amountMinor: 20_000, // $200.00
        direction: "out",
        merchant: "Grocery Co",
        categoryId: foodCat.id,
      },
      now,
    );
    createManualTransaction(
      db,
      {
        accountId: checkingId,
        date: "2026-10-22",
        amountMinor: 5_000, // $50.00
        direction: "out",
        merchant: "Clothing Store",
        categoryId: shoppingCat.id,
      },
      now,
    );

    const result = await askFinancialAssistant(
      db,
      "show me my top spending category in the past 2 weeks",
      { today },
    );

    expect(result.privacy.zeroDataShared).toBe(true);
    expect(result.visualization.items?.[0].label).toBe("Food & Dining");
    expect(result.visualization.items?.[0].valueMinor).toBe(35_000); // $350.00
    expect(result.visualization.items?.[0].valueFormatted).toBe("$350.00");
    expect(result.narrative).toContain("Food & Dining");
    expect(result.narrative).toContain("$350.00");
    expect(result.narrative).not.toContain("{{top_name}}"); // verified fully hydrated
  });

  it("projects goal funding pace and budget burn into forecast", () => {
    const db = setupTestDb();
    const today = "2026-10-15";

    createManualBankAccount(
      db,
      { name: "Checking", kind: "checking", openingBalanceMinor: 200_000 },
      new Date().toISOString(),
    );

    // Create a savings goal for $1,000 in 5 months ($200/mo)
    createGoal(db, {
      name: "Emergency Fund",
      targetMinor: 100_000,
      targetDate: "2027-03-15",
    });

    // Create a budget with $500 allowance
    const diningCat = createCategory(db, { name: "Dining" });
    createBudget(
      db,
      {
        categoryId: diningCat.id,
        month: "2026-10",
        amountMinor: 50_000,
      },
      "fake",
    );

    const forecastWithExtensions = cashForecast(db, {
      today,
      days: 60,
      includeGoals: true,
      includeBudget: true,
    });

    const goalEvents = forecastWithExtensions.days
      .flatMap((d) => d.events)
      .filter((e) => e.source === "goal_plan");
    const budgetEvents = forecastWithExtensions.days
      .flatMap((d) => d.events)
      .filter((e) => e.source === "budget_allowance");

    expect(goalEvents.length).toBeGreaterThan(0);
    expect(goalEvents[0].label).toContain("Emergency Fund");
    expect(budgetEvents.length).toBeGreaterThan(0);
  });
});

describe("Model Context Protocol (MCP) Financial Tools", () => {
  it("declares tool schemas with opaque dataset references", () => {
    const tools = listFinancialMcpTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("finance_ask");
    expect(toolNames).toContain("finance_plan_query");
    expect(toolNames).toContain("finance_execute_private_plan");
    expect(toolNames).toContain("finance_list_capabilities");
  });

  it("executes MCP tool and retains zero personal data leakage", async () => {
    const db = setupTestDb();
    const today = "2026-10-31";

    const res = await executeFinancialMcpTool(db, "finance_ask", {
      query: "show me my top spending category in the past 2 weeks",
      today,
    });

    expect(res.privacy.zeroDataShared).toBe(true);
    expect(res.visualization).toBeDefined();
  });
});
