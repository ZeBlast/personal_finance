import { describe, expect, it } from "vitest";
import { goalAccountText, goalForecastInput, goalForecastText } from "./GoalsPage";

const account = {
  id: 1,
  name: "Savings",
  balanceMinor: 500_000,
  countedMinor: 500_000,
  setMinor: null,
  short: false,
  sharedWith: [],
};

describe("what a goal owns of an account", () => {
  it("is the whole balance when no other goal uses it", () => {
    expect(goalAccountText(account)).toBe("Savings: $5,000.00");
  });
  it("shows the share and who else uses the account", () => {
    expect(
      goalAccountText({
        ...account,
        countedMinor: 150_000,
        setMinor: 150_000,
        sharedWith: ["Car"],
      }),
    ).toBe("Savings: $1,500.00 of $5,000.00 (set amount; shared with Car)");
    expect(
      goalAccountText({
        ...account,
        countedMinor: 0,
        setMinor: 10_000,
        short: true,
        sharedWith: ["Car"],
      }),
    ).toBe("Savings: $0.00 of $5,000.00 ($100.00 set, not enough left; shared with Car)");
  });
});

describe("saying a goal counts in the cash forecast", () => {
  it("names the amount and the day, and stays quiet otherwise", () => {
    const f = (day: number) => ({ forecast: { monthlyMinor: 50_000, day }, reached: false });
    expect(goalForecastText(f(15))).toBe(
      "$500.00 a month counts in the cash forecast, on the 15th.",
    );
    const day = (d: number) => goalForecastText(f(d))!.match(/the (\w+)\.$/)![1];
    expect([1, 2, 3, 11, 12, 13, 21, 22, 28].map(day)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "28th",
    ]);
    expect(goalForecastText({ forecast: null, reached: false })).toBeNull();
    expect(goalForecastText({ ...f(5), reached: true })).toBeNull();
  });
});

describe("the monthly contribution counted in the cash forecast", () => {
  it("is nothing when switched off, and needs an amount and a day from 1 to 28", () => {
    expect(goalForecastInput(false, "", "1")).toBeNull();
    expect(goalForecastInput(true, "400.00", "5")).toEqual({ monthlyMinor: 40_000, day: 5 });
    expect(goalForecastInput(true, "", "5")).toBeUndefined();
    expect(goalForecastInput(true, "400", "29")).toBeUndefined();
  });
});
