import { describe, expect, it } from "vitest";
import { dayOfMonth } from "./StatementsDialog";

describe("statement days in words", () => {
  it("reads like a date, with 31 as the month's last day", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30].map(dayOfMonth)).toEqual([
      "the 1st",
      "the 2nd",
      "the 3rd",
      "the 4th",
      "the 11th",
      "the 12th",
      "the 13th",
      "the 21st",
      "the 22nd",
      "the 23rd",
      "the 30th",
    ]);
    expect(dayOfMonth(31)).toBe("the last day");
  });
});
