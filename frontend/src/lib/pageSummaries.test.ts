import { describe, expect, it } from "vitest";
import type { Account } from "../types/api";
import type { PeriodSummary } from "../types/calendar";
import type { MonthReport } from "../types/planning";
import {
  accountsSentence,
  calendarSentence,
  scenarioSentence,
  spendingSentence,
  subscriptionsSentence,
  taxesSentence,
} from "./pageSummaries";
import { evaluate, newNode, type Graph } from "./sandbox/graph";

const account = (over: Partial<Account>): Account =>
  ({
    type: "depository",
    currency: "USD",
    currentBalanceMinor: 0,
    hidden: false,
    countsInTotals: true,
    ...over,
  }) as Account;

describe("accountsSentence", () => {
  it("adds up the bank and the debts", () => {
    expect(
      accountsSentence([
        account({ currentBalanceMinor: 97000 }),
        account({ type: "credit", currentBalanceMinor: 88000 }),
        account({ type: "loan", currentBalanceMinor: 1300000 }),
        account({ type: "credit", currentBalanceMinor: -5000 }),
      ]),
    ).toBe("$970.00 in the bank, $13,880.00 owed across 2 debts.");
  });
  it("leaves out hidden accounts and says something plain when none are left", () => {
    expect(accountsSentence([])).toBe("No accounts yet.");
    expect(accountsSentence([account({ hidden: true })])).toBe("No accounts yet.");
  });
  it("copes with only one kind of account", () => {
    expect(accountsSentence([account({ type: "credit", currentBalanceMinor: 5000 })])).toBe(
      "$50.00 owed across 1 debt.",
    );
    expect(accountsSentence([account({ type: "investment" })])).toBe("1 account so far.");
  });
});

describe("calendarSentence", () => {
  const summary = (balance: Partial<PeriodSummary["balance"]> = {}, over = {}): PeriodSummary =>
    ({
      currency: "USD",
      spendingMinor: 175907,
      incomeMinor: 0,
      expected: { count: 0, outflowMinor: 0, inflowMinor: 0 },
      balance: { endMinor: 56000, projected: false, ...balance },
      ...over,
    }) as PeriodSummary;
  it("gives the month's spending and what is left after cards", () => {
    expect(calendarSentence(summary(), "November")).toBe(
      "November: $1,759.07 spent, $560.00 left after cards.",
    );
  });
  it("says when cash falls short, and leaves out an unknown balance", () => {
    expect(calendarSentence(summary({ endMinor: -2000, projected: true }), "May")).toBe(
      "May: $1,759.07 spent, $20.00 short after cards by month end.",
    );
    expect(calendarSentence(summary({ endMinor: null }), "May")).toBe("May: $1,759.07 spent.");
  });
  it("says so when the month is empty", () => {
    expect(calendarSentence(summary({}, { spendingMinor: 0 }), "March")).toBe(
      "Nothing recorded or expected in March.",
    );
  });
});

describe("subscriptionsSentence", () => {
  it("counts what is tracked and what was found", () => {
    expect(
      subscriptionsSentence({
        currency: "USD",
        tracked: { count: 2, monthlyMinor: 3000 },
        found: { count: 1, monthlyMinor: 145000 },
      }),
    ).toBe("2 subscriptions tracked, $30.00 a month; 1 recurring charge found, $1,450.00 a month.");
  });
  it("says so when there is nothing", () => {
    expect(
      subscriptionsSentence({
        currency: "USD",
        tracked: { count: 0, monthlyMinor: 0 },
        found: { count: 0, monthlyMinor: 0 },
      }),
    ).toBe("No subscriptions tracked and no recurring charges found yet.");
  });
});

describe("spendingSentence", () => {
  const report = (over: Partial<MonthReport>): MonthReport =>
    ({
      currency: "USD",
      spendingMinor: 50000,
      categories: [
        { label: "Dining", spendingMinor: 12000 },
        { label: "Rent", spendingMinor: 30000 },
      ],
      ...over,
    }) as MonthReport;
  it("names the biggest category", () => {
    expect(spendingSentence(report({}), "November 2026")).toBe(
      "November 2026 so far: $500.00 spent, the most on Rent.",
    );
  });
  it("says so when nothing was spent", () => {
    expect(spendingSentence(report({ spendingMinor: 0, categories: [] }), "May 2026")).toBe(
      "Nothing spent in May 2026 yet.",
    );
  });
});

describe("taxesSentence", () => {
  const usd = (d: number) => `$${d}`;
  it("gives the estimate in a line", () => {
    expect(
      taxesSentence(2026, { grossIncome: 80000, total: 14000, effectiveRate: 0.175 }, usd),
    ).toBe("About $14000 in taxes on $80000 of income in 2026, 17.5% in all.");
  });
  it("never shows a rate with no income", () => {
    expect(taxesSentence(2026, { grossIncome: 0, total: 0, effectiveRate: 0 }, usd)).toBe(
      "No income for 2026 yet, so no tax is estimated.",
    );
  });
});

describe("scenarioSentence", () => {
  const usd = (d: number) => `$${d}`;
  it("asks for a result when there is none", () => {
    const graph: Graph = { nodes: [], wires: [] };
    expect(scenarioSentence(graph, evaluate(graph), usd)).toMatch(/^Wire something into a Result/);
  });
  it("shows what a wired result comes to, yearly and monthly", () => {
    const income = newNode("income", "a", 0, 0);
    const result = { ...newNode("result", "b", 0, 0), title: "Take-home" };
    const graph: Graph = {
      nodes: [income, result],
      wires: [{ id: "w", from: { node: "a", port: "yearly" }, to: { node: "b", port: "value" } }],
    };
    const ev = evaluate(graph);
    const yearly = ev.inputs["b"]?.["value"];
    expect(yearly).toBeGreaterThan(0);
    expect(scenarioSentence(graph, ev, usd)).toBe(
      `Take-home: $${yearly} a year, $${yearly! / 12} a month.`,
    );
  });
});
