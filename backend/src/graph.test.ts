import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("transaction graph", () => {
  it("gathers institutions, accounts, and transactions with transfers and income", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    await h.call("post", "/api/accounts/manual").send({ name: "Wallet", kind: "cash" }).expect(201);

    const g = (
      await h.call("get", "/api/graph/transactions?from=2026-01-01&to=2026-12-31").expect(200)
    ).body;
    expect(g.institutions.map((i: { name: string }) => i.name)).toEqual([
      "First Platypus Bank",
      "Kept by hand",
    ]);
    const wallet = g.accounts.find((a: { name: string }) => a.name === "Wallet");
    expect(wallet.institutionId).toBe("manual");
    expect(g.transactions.length).toBeGreaterThan(5);
    const ids = new Set(g.accounts.map((a: { id: number }) => a.id));
    for (const t of g.transactions) expect(ids.has(t.accountId)).toBe(true);
    // The demo paycheck is income, with who paid it.
    const pay = g.transactions.find((t: { income: boolean }) => t.income);
    expect(pay).toMatchObject({ income: true });
    expect(pay.source).toBeTruthy();
    expect(g.truncated).toBe(false);
  });

  it("marks subcategories and the person on the other side of a payment", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    const db = h.sqlite;
    const parent = db
      .prepare(
        "insert into categories (name, created_at, updated_at) values ('Test Parent', '2026-01-01', '2026-01-01') returning id",
      )
      .get() as { id: number };
    const sub = db
      .prepare(
        "insert into categories (name, parent_id, created_at, updated_at) values ('Test Sub', ?, '2026-01-01', '2026-01-01') returning id",
      )
      .get(parent.id) as { id: number };
    const [a, b] = db
      .prepare("select id from transactions where amount_minor > 0 order by id limit 2")
      .all() as Array<{ id: number }>;
    db.prepare("update transactions set category_id = ? where id = ?").run(sub.id, a!.id);
    db.prepare("update transactions set recipient_user = 'Sam Lee' where id = ?").run(b!.id);

    const g = (
      await h.call("get", "/api/graph/transactions?from=2000-01-01&to=2030-12-31").expect(200)
    ).body;
    const ta = g.transactions.find((t: { id: number }) => t.id === a!.id);
    expect(ta).toMatchObject({
      categoryId: parent.id,
      subcategoryId: sub.id,
      subcategoryName: "Test Sub",
    });
    expect(g.transactions.find((t: { id: number }) => t.id === b!.id).person).toBe("Sam Lee");
  });

  it("refuses a backwards range", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("get", "/api/graph/transactions?from=2026-02-01&to=2026-01-01").expect(400);
  });
});

describe("opening a transaction from the graph", () => {
  it("shows the page that holds it", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const account = (
      await t.call("post", "/api/accounts/manual").send({ name: "Cash", kind: "cash" }).expect(201)
    ).body.id as number;
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const res = await t
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: `2026-08-${day}`,
          merchant: `Shop ${i}`,
          amountMinor: 100 + i,
          direction: "out",
        })
        .expect(201);
      ids.push(res.body.id as number);
    }
    // Newest first, 10 a page: find where the oldest-dated one is, then ask for it.
    const all = (await t.call("get", "/api/transactions?pageSize=60").expect(200)).body
      .items as Array<{ id: number }>;
    const target = all[37]!.id;
    const res = (await t.call("get", `/api/transactions?pageSize=10&focus=${target}`).expect(200))
      .body;
    expect(res.page).toBe(4);
    expect(res.items.map((x: { id: number }) => x.id)).toContain(target);
    // Not in the filtered list: the asked-for page is kept.
    const other = (
      await t
        .call("get", `/api/transactions?pageSize=10&page=2&focus=${target}&q=nothing-matches`)
        .expect(200)
    ).body;
    expect(other.page).toBe(2);
    expect(ids).toContain(target);
  });
});
