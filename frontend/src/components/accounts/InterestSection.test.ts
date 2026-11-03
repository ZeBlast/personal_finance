import { describe, expect, it } from "vitest";
import { formatApy, parseApy } from "./InterestSection";

describe("reading an APY", () => {
  it("takes a percent with up to two decimals, from 0 to 50", () => {
    expect(parseApy("4.25")).toBe(425);
    expect(parseApy(" 4.25% ")).toBe(425);
    expect(parseApy("0")).toBe(0);
    expect(parseApy("51")).toBeNull();
    expect(parseApy("4.255")).toBeNull();
    expect(parseApy("abc")).toBeNull();
    expect(formatApy(425)).toBe("4.25%");
  });
});
