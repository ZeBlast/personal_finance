import { describe, expect, it } from "vitest";
import type { GeocodeStatus } from "../types/places";
import { lookupProgress, resetNote } from "./geocode";

const status = (over: Partial<GeocodeStatus>): GeocodeStatus => ({
  enabled: true,
  server: "https://nominatim.openstreetmap.org",
  running: false,
  total: 0,
  done: 0,
  found: 0,
  notFound: 0,
  pending: 0,
  unplaced: 0,
  stopped: null,
  message: null,
  resetAvailableAt: null,
  ...over,
});

describe("lookupProgress", () => {
  it("says how far along a run is and about how long is left", () => {
    expect(
      lookupProgress(status({ running: true, total: 10, done: 4, found: 3, notFound: 1 })),
    ).toEqual({
      percent: 40,
      text: "Made 4 of 10 lookups: 3 found a position, 1 found nothing.",
      eta: "About 12 seconds left.",
      tone: "info",
    });
    expect(lookupProgress(status({ running: true, total: 100, done: 10 })).eta).toBe(
      "About 3 minutes left.",
    );
  });

  it("offers the purchases waiting when nothing is running", () => {
    expect(lookupProgress(status({ pending: 4, unplaced: 7 }))).toMatchObject({
      percent: null,
      text: "7 purchases have location details but no map position yet.",
      tone: "info",
    });
    expect(lookupProgress(status({ pending: 0, unplaced: 0 })).text).toBe(
      "Every purchase with location details has been looked up.",
    );
  });

  it("explains a run that stopped early", () => {
    const p = lookupProgress(
      status({
        total: 5,
        done: 2,
        found: 2,
        pending: 3,
        unplaced: 3,
        stopped: "refused",
        message: "The address lookup server asked us to stop for now. Try again later.",
      }),
    );
    expect(p.tone).toBe("warn");
    expect(p.text).toBe(
      "The address lookup server asked us to stop for now. Try again later. 2 of 5 lookups were made.",
    );
  });

  it("reports a finished run", () => {
    expect(
      lookupProgress(status({ total: 3, done: 3, found: 2, notFound: 1, pending: 0 })).text,
    ).toBe("Done: 2 of 3 lookups found a position.");
  });
});

describe("resetNote", () => {
  it("says when everything can next be looked up again", () => {
    expect(resetNote(status({}))).toBeNull();
    expect(resetNote(status({ resetAvailableAt: "2026-11-15T10:00:00.000Z" }))).toMatch(
      /^Available again on /,
    );
  });
});
