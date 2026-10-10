import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Two purchases: A made Sep 28 but posted Oct 2; B made and posted Sep 30. */
async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "credit_card" })
      .expect(201)
  ).body.id as number;
  const add = async (merchant: string, date: string) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: account, date, merchant, amountMinor: 1000, direction: "out" })
        .expect(201)
    ).body.id as number;
  const a = await add("A", "2026-10-02");
  await add("B", "2026-09-30");
  t.sqlite.prepare("UPDATE transactions SET authorized_date = '2026-09-28' WHERE id = ?").run(a);
  return t;
}

const merchants = (body: { items: Array<{ merchant: string }> }) =>
  body.items.map((x) => x.merchant);

describe("transaction date and posted date", () => {
  it("lists by transaction date by default, and can sort by the posted date", async () => {
    const t = await setup();
    expect(merchants((await t.call("get", "/api/transactions").expect(200)).body)).toEqual([
      "B",
      "A",
    ]);
    expect(
      merchants((await t.call("get", "/api/transactions?sort=date_desc").expect(200)).body),
    ).toEqual(["A", "B"]);
    expect(
      merchants((await t.call("get", "/api/transactions?sort=txdate_asc").expect(200)).body),
    ).toEqual(["A", "B"]);
  });

  it("filters a range by transaction date unless the posted date is asked for", async () => {
    const t = await setup();
    const sept = "from=2026-09-01&to=2026-09-30";
    expect(
      merchants((await t.call("get", `/api/transactions?${sept}`).expect(200)).body).sort(),
    ).toEqual(["A", "B"]);
    expect(
      merchants(
        (await t.call("get", `/api/transactions?${sept}&dateBasis=posted`).expect(200)).body,
      ),
    ).toEqual(["B"]);
  });

  it("places the calendar by transaction date by default, or by posted date", async () => {
    const t = await setup();
    const days = async (q: string) =>
      (
        (await t.call("get", `/api/analytics/calendar?month=2026-09${q}`).expect(200)).body
          .days as Array<{
          date: string;
        }>
      ).map((d) => d.date);
    expect(await days("")).toEqual(["2026-09-28", "2026-09-30"]);
    expect(await days("&dateBasis=posted")).toEqual(["2026-09-30"]);
    const out = async (q: string) =>
      (await t.call("get", `/api/calendar/summary?from=2026-09-01&to=2026-09-30${q}`).expect(200))
        .body.moneyOutMinor as number;
    expect(await out("")).toBe(2000);
    expect(await out("&dateBasis=posted")).toBe(1000);
  });
});
