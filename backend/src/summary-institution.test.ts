import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("summaries narrowed to one bank", () => {
  it("count only that bank's accounts, or only those kept by hand", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    const wallet = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id as number;
    await h
      .call("post", "/api/transactions")
      .send({
        accountId: wallet,
        date: "2026-08-20",
        merchant: "Kiosk",
        amountMinor: 1234,
        direction: "out",
      })
      .expect(201);

    const spending = async (query: string) =>
      (
        await h
          .call("get", `/api/analytics/summary?from=2026-01-01&to=2026-12-31${query}`)
          .expect(200)
      ).body.totals.spendingMinor as number;
    const all = await spending("");
    const manual = await spending("&institution=manual");
    const bank = await spending(`&institution=${encodeURIComponent("First Platypus Bank")}`);
    expect(manual).toBe(1234);
    expect(bank).toBeGreaterThan(0);
    expect(bank + manual).toBe(all);
    expect(await spending("&institution=Nobody%20Bank")).toBe(0);
  });
});
