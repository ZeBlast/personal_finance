import { describe, expect, it } from "vitest";
import { planningView } from "../../pages/PlanningPage";
import { sectionLabel } from "../../hooks/usePreviousPage";
import { freshnessWarning, type DailyBrief } from "../../widgets/DailyBriefWidget";
import { reconcileVerdict, type Reconciliation } from "../accounts/ReconcileDialog";
import { areaBadge } from "./NavBadge";

describe("navigation badges", () => {
  const badges = {
    "/transactions/review": { count: 4, tone: "info" as const, label: "4 to review" },
    "/accounts": { count: 1, tone: "warn" as const, label: "1 bank connection needs attention" },
    "/planning/subscriptions": { count: 2, tone: "info" as const, label: "2 coming up" },
  };
  it("add up an area's sections, warning if any section warns", () => {
    expect(areaBadge(badges, "/transactions")).toEqual({
      count: 4,
      tone: "info",
      label: "4 to review",
    });
    expect(areaBadge(badges, "/accounts")?.tone).toBe("warn");
    expect(areaBadge(badges, "/planning")?.count).toBe(2);
    expect(areaBadge(badges, "/reports")).toBeNull();
  });
});

describe("addresses for views", () => {
  it("open the Planning view named in the address, else the forecast", () => {
    expect(planningView("bills")).toBe("bills");
    expect(planningView("paychecks")).toBe("paychecks");
    expect(planningView(null)).toBe("forecast");
    expect(planningView("nonsense")).toBe("forecast");
  });
  it("name the section a page came from", () => {
    expect(sectionLabel("/reports/insights")).toBe("Insights");
    expect(sectionLabel("/nowhere")).toBeNull();
  });
});

describe("safe to spend", () => {
  const base = { staleAccounts: [] } as unknown as DailyBrief;
  it("warns when the starting cash rests on old balances", () => {
    expect(freshnessWarning(base)).toBeNull();
    expect(
      freshnessWarning({
        ...base,
        staleAccounts: [{ name: "Checking", updatedAt: null, needsSignIn: false }],
      }),
    ).toMatch(/^Checking has not synced in over a day/);
    expect(
      freshnessWarning({
        ...base,
        staleAccounts: [
          { name: "Checking", updatedAt: null, needsSignIn: false },
          { name: "Savings", updatedAt: null, needsSignIn: true },
        ],
      }),
    ).toMatch(/^Savings needs signing in again/);
  });
});

describe("reconciling", () => {
  const r = { type: "depository", differenceMinor: 0 } as Reconciliation;
  it("says whether the statement matches, and where to look when not", () => {
    expect(reconcileVerdict(r)).toMatch(/^It matches/);
    expect(reconcileVerdict({ ...r, differenceMinor: 1_500 })).toMatch(
      /^The statement is \$15\.00 higher than the app: a deposit may be missing here/,
    );
    expect(reconcileVerdict({ ...r, type: "credit", differenceMinor: -200 })).toMatch(
      /\$2\.00 lower .* a charge may be counted twice here/,
    );
    expect(reconcileVerdict({ ...r, differenceMinor: null })).toMatch(/^Enter the statement/);
  });
});
