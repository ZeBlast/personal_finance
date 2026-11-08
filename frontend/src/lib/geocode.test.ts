import { describe, expect, it } from "vitest";
import type { GeocodeStatus } from "../types/places";
import { lookupProgress } from "./geocode";

const status = (over: Partial<GeocodeStatus>): GeocodeStatus => ({
  enabled: true,
  server: "https://nominatim.openstreetmap.org",
  running: false,
  total: 0,
  done: 0,
  found: 0,
  notFound: 0,
  pending: 0,
  stopped: null,
  message: null,
  ...over,
});

describe("lookupProgress", () => {
  it("says how far along a run is and about how long is left", () => {
    expect(
      lookupProgress(status({ running: true, total: 10, done: 4, found: 3, notFound: 1 })),
    ).toEqual({
      percent: 40,
      text: "Looked up 4 of 10 addresses: 3 found, 1 not found.",
      eta: "About 12 seconds left.",
      tone: "info",
    });
    expect(lookupProgress(status({ running: true, total: 100, done: 10 })).eta).toBe(
      "About 3 minutes left.",
    );
  });

  it("offers the addresses waiting when nothing is running", () => {
    expect(lookupProgress(status({ pending: 7 }))).toMatchObject({
      percent: null,
      text: "7 addresses came without a map position and can be looked up.",
      tone: "info",
    });
    expect(lookupProgress(status({ pending: 0 })).text).toBe(
      "Every address with a street has been looked up.",
    );
  });

  it("explains a run that stopped early", () => {
    const p = lookupProgress(
      status({
        total: 5,
        done: 2,
        found: 2,
        pending: 3,
        stopped: "refused",
        message: "The address lookup server asked us to stop for now. Try again later.",
      }),
    );
    expect(p.tone).toBe("warn");
    expect(p.text).toBe(
      "The address lookup server asked us to stop for now. Try again later. 2 of 5 were looked up.",
    );
  });

  it("reports a finished run", () => {
    expect(
      lookupProgress(status({ total: 3, done: 3, found: 2, notFound: 1, pending: 0 })).text,
    ).toBe("Done: 2 of 3 addresses found on the map.");
  });
});
