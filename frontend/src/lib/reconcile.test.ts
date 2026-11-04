import { describe, expect, it } from "vitest";
import type { Account } from "../types/api";
import {
  causeLines,
  checkedNote,
  shortDay,
  unconfirmedNote,
  type ReconcileLine,
  type Reconciliation,
} from "./reconcile";
import { formatDay } from "./time";

const r = {
  type: "depository",
  duplicates: [],
  gaps: [],
} as unknown as Reconciliation;

const line = (id: number, date: string): ReconcileLine => ({
  id,
  date,
  merchant: "Shop",
  amountMinor: 2_000,
  pending: false,
});

describe("causeLines", () => {
  it("lists a possible double charge and an unusually quiet stretch", () => {
    expect(
      causeLines(
        {
          ...r,
          duplicates: [[line(1, "2026-10-05"), line(2, "2026-10-05")]],
          gaps: [{ from: "2026-10-12", to: "2026-10-25", reason: "quiet" }],
        },
        "USD",
      ),
    ).toEqual([
      `Possibly the same charge twice: Shop on ${shortDay("2026-10-05")} ($20.00)`,
      `No transactions from ${shortDay("2026-10-12")} to ${shortDay("2026-10-25")}, which is unusual for this account`,
    ]);
  });

  it("names both days when the pair is on different days", () => {
    const [text] = causeLines(
      { ...r, duplicates: [[line(1, "2026-10-05"), line(2, "2026-10-06")]] },
      "USD",
    );
    expect(text).toContain(`${shortDay("2026-10-05")} and ${shortDay("2026-10-06")}`);
  });

  it("explains the other reasons a stretch may be missing", () => {
    expect(
      causeLines(
        {
          ...r,
          gaps: [
            { from: "2026-09-20", to: "2026-10-09", reason: "before_history" },
            { from: "2026-10-21", to: "2026-10-31", reason: "not_synced" },
            { from: "2026-10-21", to: "2026-10-31", reason: "no_longer_shared" },
          ],
        },
        "USD",
      ),
    ).toEqual([
      `The app's records start on ${shortDay("2026-10-10")}: anything before is missing`,
      `Not synced since ${shortDay("2026-10-20")}`,
      `The bank stopped sharing this account on ${shortDay("2026-10-21")}`,
    ]);
  });
});

describe("unconfirmedNote", () => {
  it("says why a check cannot be confirmed when the records stop short", () => {
    expect(unconfirmedNote([{ from: "2026-10-21", to: "2026-10-31", reason: "not_synced" }])).toBe(
      `Your records stop on ${shortDay("2026-10-20")}, so this can't be confirmed yet — sync and check again.`,
    );
  });

  it("is null for gaps that do not stop the records short", () => {
    expect(unconfirmedNote([{ from: "2026-10-12", to: "2026-10-25", reason: "quiet" }])).toBeNull();
    expect(unconfirmedNote([])).toBeNull();
  });
});

describe("checkedNote", () => {
  const acct = { id: 1, lastReconciled: null } as unknown as Account;

  it("says when an account was last checked and matched", () => {
    expect(
      checkedNote({ ...acct, lastReconciled: { statementDate: "2026-10-31", status: "matched" } }),
    ).toBe(`Checked against a statement on ${formatDay("2026-10-31")}`);
  });

  it("says nothing for an unresolved check or none at all", () => {
    expect(
      checkedNote({
        ...acct,
        lastReconciled: { statementDate: "2026-10-31", status: "unresolved" },
      }),
    ).toBeNull();
    expect(checkedNote(acct)).toBeNull();
  });
});
