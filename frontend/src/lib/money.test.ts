import { describe, expect, it } from "vitest";
import {
  currencyDigits,
  formatAxisMoney,
  formatMinor,
  formatQuantity,
  parseDecimal,
  parseMoneyToMinor,
} from "./money";

describe("parseMoneyToMinor", () => {
  it("reads whole and decimal amounts into minor units exactly", () => {
    expect(parseMoneyToMinor("2500", "USD")).toBe(250000);
    expect(parseMoneyToMinor("2500.5", "USD")).toBe(250050);
    expect(parseMoneyToMinor("2500.50", "USD")).toBe(250050);
    expect(parseMoneyToMinor("0.07", "USD")).toBe(7);
    expect(parseMoneyToMinor("19.99", "USD")).toBe(1999); // would be 1998.9999... with floating point
    expect(parseMoneyToMinor("2500.", "USD")).toBe(250000);
  });

  it("accepts currency symbols, thousands separators, and spaces", () => {
    expect(parseMoneyToMinor("$2,500", "USD")).toBe(250000);
    expect(parseMoneyToMinor(" $ 2,500.50 ", "USD")).toBe(250050);
    expect(parseMoneyToMinor("1 200.5", "USD")).toBe(120050);
  });

  it("refuses anything that is not a clean positive amount", () => {
    for (const bad of [
      "",
      "   ",
      "abc",
      "-5",
      "0",
      "0.00",
      "1.234",
      "1..2",
      "1e3",
      "5%",
      "12abc",
      ".5",
      "$",
    ]) {
      expect(parseMoneyToMinor(bad, "USD"), `"${bad}"`).toBeNull();
    }
  });

  it("refuses more decimal places than the currency has, instead of rounding silently", () => {
    expect(parseMoneyToMinor("1.005", "USD")).toBeNull();
    expect(parseMoneyToMinor("1.5", "JPY")).toBeNull();
    expect(parseMoneyToMinor("1500", "JPY")).toBe(1500);
  });

  it("refuses amounts too large to store exactly", () => {
    expect(parseMoneyToMinor("99999999999999999999", "USD")).toBeNull();
  });
});

describe("currency formatting", () => {
  it("knows each currency's decimal places", () => {
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
  });

  it("formats minor units and shows a dash for no value", () => {
    expect(formatMinor(250050, "USD")).toContain("2,500.50");
    expect(formatMinor(-100, "USD")).toContain("1.00");
    expect(formatMinor(null, "USD")).toBe("—");
  });
});

describe("parseMoneyToMinor with zero allowed", () => {
  it("accepts zero only when asked", () => {
    expect(parseMoneyToMinor("0", "USD")).toBeNull();
    expect(parseMoneyToMinor("0", "USD", { allowZero: true })).toBe(0);
    expect(parseMoneyToMinor("0.00", "USD", { allowZero: true })).toBe(0);
    expect(parseMoneyToMinor("-1", "USD", { allowZero: true })).toBeNull();
    expect(parseMoneyToMinor("abc", "USD", { allowZero: true })).toBeNull();
  });
});

describe("parseDecimal", () => {
  it("reads plain non-negative numbers, keeping every decimal", () => {
    expect(parseDecimal("12")).toBe(12);
    expect(parseDecimal(" 1,200.5 ")).toBe(1200.5);
    expect(parseDecimal("$98.1234")).toBe(98.1234);
    expect(parseDecimal(".25")).toBe(0.25);
    expect(parseDecimal("5.")).toBe(5);
    expect(parseDecimal("0")).toBe(0);
  });

  it("rejects anything that is not a clean number", () => {
    for (const bad of ["", "abc", "-1", "1e5", "1.2.3", "12%", "1 2 x", "$", "."]) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
  });
});

describe("formatQuantity", () => {
  it("drops needless zeros and caps decimals at four", () => {
    expect(formatQuantity(12)).toBe("12");
    expect(formatQuantity(120.5)).toBe("120.5");
    expect(formatQuantity(0.123456)).toBe("0.1235");
  });
});

describe("formatAxisMoney", () => {
  it("shortens whole dollars, with the minus sign in front of the dollar sign", () => {
    expect(formatAxisMoney(45000)).toBe("$450");
    expect(formatAxisMoney(120000)).toBe("$1.2k");
    expect(formatAxisMoney(300000)).toBe("$3k");
    expect(formatAxisMoney(0)).toBe("$0");
    expect(formatAxisMoney(-9400)).toBe("-$94");
    expect(formatAxisMoney(-250000)).toBe("-$2.5k");
    expect(formatAxisMoney(-30)).toBe("$0"); // rounds to zero: no stray minus
  });
});
