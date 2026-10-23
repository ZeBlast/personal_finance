import { afterEach, describe, expect, it } from "vitest";
import { navBadges } from "./services/badges.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("navigation badges", () => {
  it("count what is waiting, and leave out what is not", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    expect((await t.call("get", "/api/nav/badges").expect(200)).body).toEqual({});
    const id = (
      await t.call("post", "/api/accounts/manual").send({ name: "Cash", kind: "cash" }).expect(201)
    ).body.id as number;
    const today = new Date().toISOString().slice(0, 10);
    // A new merchant, uncategorized: on the review list and among the uncategorized.
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: id,
        date: today,
        merchant: "Odd Shop",
        amountMinor: 1_000,
        direction: "out",
      })
      .expect(201);
    const badges = navBadges(t.db);
    expect(badges["/transactions/review"]?.count).toBeGreaterThanOrEqual(1);
    expect(badges["/transactions/review"]?.label).toMatch(/uncategorized/);
    expect(badges["/accounts"]).toBeUndefined();
  });
});
