import { describe, expect, it } from "vitest";
import { parseOwnNames } from "./OwnNamesSection";

describe("reading the names you go by", () => {
  it("takes one per line or comma, trims, drops short and repeated ones", () => {
    expect(parseOwnNames("Jane Doe\n  jane   doe , Ze Blast,\nJD\n")).toEqual([
      "Jane Doe",
      "Ze Blast",
    ]);
    expect(parseOwnNames("")).toEqual([]);
  });
});
