import { describe, expect, it } from "vitest";
import { isPaycheckSource } from "./TaxesPage";

describe("isPaycheckSource", () => {
  it("is true for pay found in the transactions", () => {
    expect(isPaycheckSource({ kind: "income" }, { kind: "income", wages: true })).toBe(true);
  });

  it("is false for interest, dividends, money from people and credits", () => {
    expect(isPaycheckSource({ kind: "income" }, { kind: "income", wages: false })).toBe(false);
    expect(isPaycheckSource({ kind: "credit" }, { kind: "credit", wages: false })).toBe(false);
  });

  it("keeps every field for a source added by hand", () => {
    expect(isPaycheckSource({ kind: "manual" }, undefined)).toBe(true);
  });
});
