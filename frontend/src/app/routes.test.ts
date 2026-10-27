import { describe, expect, it } from "vitest";
import { areaOf, areas, LEGACY_PATHS, migrateNavOrder, routes } from "./routes";

describe("navigation areas", () => {
  it("has nine areas, and every page has one address", () => {
    expect(areas.map((a) => a.label)).toEqual([
      "Dashboard",
      "Transactions",
      "Calendar",
      "Planning",
      "Accounts",
      "Reports",
      "Taxes",
      "What-if",
      "Settings",
    ]);
    const paths = routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Each area's first section lives at the area's own address.
    for (const a of areas) expect(a.sections[0]!.path).toBe(a.path);
  });

  it("sends every old address to a page that exists", () => {
    const paths = new Set(routes.map((r) => r.path));
    for (const to of Object.values(LEGACY_PATHS)) expect(paths.has(to)).toBe(true);
    for (const from of Object.keys(LEGACY_PATHS)) expect(paths.has(from)).toBe(false);
  });

  it("finds the area of a page, old or new", () => {
    expect(areaOf("/reports/network")).toBe("/reports");
    expect(areaOf("/network")).toBe("/reports");
    expect(areaOf("/data")).toBe("/settings");
    expect(areaOf("/")).toBe("/");
    expect(areaOf("/gone")).toBeNull();
  });

  it("carries a saved sidebar order over to the areas", () => {
    expect(
      migrateNavOrder([
        "/review",
        "/calendar",
        "/transactions",
        "/goals",
        "/gone",
        "/budgets",
        "/",
      ]),
    ).toEqual(["/transactions", "/calendar", "/planning", "/"]);
    expect(migrateNavOrder(["/settings", "/data"])).toEqual(["/settings"]);
  });
});
