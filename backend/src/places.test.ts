import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Purchase {
  id: number;
  date: string;
  datetime: string | null;
  merchant: string;
  amountMinor: number;
  lat: number | null;
  lon: number | null;
}

describe("places", () => {
  it("is empty on a new app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", "/api/places?from=2026-01-01&to=2026-10-31").expect(200);
    expect(res.body).toMatchObject({ counted: 0, withPlace: 0, withTime: 0, purchases: [] });
  });

  it("refuses a span longer than three years", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("get", "/api/places?from=2020-01-01&to=2026-10-31").expect(400);
  });

  it("lists purchases with where and when, leaving out income and transfers", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const res = await h.call("get", "/api/places?from=2025-01-01&to=2026-12-31").expect(200);
    const purchases = res.body.purchases as Purchase[];
    expect(purchases.length).toBe(res.body.counted);
    expect(purchases.length).toBeGreaterThan(0);
    expect(purchases.every((p) => p.amountMinor > 0)).toBe(true);
    expect(purchases.some((p) => /payroll/i.test(p.merchant))).toBe(false);
    const placed = purchases.filter((p) => p.lat !== null && p.lon !== null);
    expect(placed.length).toBe(res.body.withPlace);
    expect(res.body.withTime).toBeGreaterThan(0);
    // The demo bank spreads its shops around town, so a map has more than one spot to show.
    expect(new Set(placed.map((p) => `${p.lat},${p.lon}`)).size).toBeGreaterThan(1);
  });
});
