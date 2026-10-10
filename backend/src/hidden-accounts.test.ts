import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Acct {
  id: number;
  name: string;
  type: string;
  hidden: boolean;
  currentBalanceMinor: number | null;
}

async function synced() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const bank = await linkDemoBank(h.call);
  await h.sync.syncItem(bank.item.id, "manual");
  const accounts = (await h.call("get", "/api/accounts").expect(200)).body as Acct[];
  return { h, itemId: bank.item.id as number, accounts };
}
type Ctx = Awaited<ReturnType<typeof synced>>;

const hide = (c: Ctx, id: number, hidden = true) =>
  c.h.call("patch", `/api/accounts/${id}`).send({ hidden });
const overview = async (c: Ctx) =>
  (await c.h.call("get", "/api/analytics/overview").expect(200)).body;
const summary = async (c: Ctx, extra = "") =>
  (
    await c.h
      .call("get", `/api/analytics/summary?from=2026-06-01&to=2026-09-30${extra}`)
      .expect(200)
  ).body.totals;
const txCount = async (c: Ctx, q = "") =>
  (await c.h.call("get", `/api/transactions?pageSize=1${q}`).expect(200)).body.total as number;

describe("hiding an account", () => {
  it("marks it hidden, lists it only when asked, and shows it again", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    expect(card.hidden).toBe(false);

    const res = await hide(c, card.id).expect(200);
    expect(res.body).toMatchObject({ id: card.id, hidden: true });

    const visible = (await c.h.call("get", "/api/accounts").expect(200)).body as Acct[];
    expect(visible.map((a) => a.id)).not.toContain(card.id);
    const all = (await c.h.call("get", "/api/accounts?includeHidden=1").expect(200)).body as Acct[];
    expect(all.find((a) => a.id === card.id)).toMatchObject({ hidden: true });
    expect(all).toHaveLength(c.accounts.length);

    // A connection's own list still shows it, so it can be shown again from there.
    const items = (await c.h.call("get", "/api/plaid/items").expect(200)).body as Array<{
      accounts: Acct[];
    }>;
    expect(items[0]!.accounts.find((a) => a.id === card.id)).toMatchObject({ hidden: true });

    await hide(c, card.id, false).expect(200);
    const back = (await c.h.call("get", "/api/accounts").expect(200)).body as Acct[];
    expect(back.map((a) => a.id)).toContain(card.id);
  });

  it("rejects an unknown account and a bad body", async () => {
    const c = await synced();
    await hide(c, 9999).expect(404);
    await c.h
      .call("patch", `/api/accounts/${c.accounts[0]!.id}`)
      .send({ hidden: "yes" })
      .expect(400);
    await c.h.call("patch", `/api/accounts/${c.accounts[0]!.id}`).send({ name: "x" }).expect(400);
  });

  it("takes the account out of balances and net worth, and back in exactly", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    const before = await overview(c);
    expect(card.currentBalanceMinor).toBeGreaterThan(0);
    await hide(c, card.id).expect(200);
    const during = await overview(c);
    expect(during.creditDebtMinor).toBe(before.creditDebtMinor - card.currentBalanceMinor!);
    expect(during.netWorthMinor).toBe(before.netWorthMinor + card.currentBalanceMinor!);
    expect(during.creditCards.map((x: { accountId: number }) => x.accountId)).not.toContain(
      card.id,
    );
    await hide(c, card.id, false).expect(200);
    expect(await overview(c)).toEqual(before);
  });

  it("takes its transactions out of the list, totals, calendar, merchants and recurring charges", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    const cardTx = await txCount(c, `&accountId=${card.id}`);
    expect(cardTx).toBeGreaterThan(0);
    const totalBefore = await txCount(c);
    const spendBefore = await summary(c);
    const calBefore = (await c.h.call("get", "/api/analytics/calendar?month=2026-08").expect(200))
      .body;
    const merchantsBefore = (await c.h.call("get", "/api/merchants?limit=500").expect(200)).body
      .total;

    await hide(c, card.id).expect(200);

    expect(await txCount(c)).toBe(totalBefore - cardTx);
    // Asking for the hidden account by name still works, so it can be inspected.
    expect(await txCount(c, `&accountId=${card.id}`)).toBe(cardTx);
    const spendDuring = await summary(c);
    expect(spendDuring.count).toBeLessThan(spendBefore.count);
    expect(spendDuring.spendingMinor).toBeLessThan(spendBefore.spendingMinor);
    const cal = (await c.h.call("get", "/api/analytics/calendar?month=2026-08").expect(200)).body;
    const accountsOnCalendar = new Set(
      cal.days.flatMap((d: { accounts: Array<{ accountId: number }> }) =>
        d.accounts.map((a) => a.accountId),
      ),
    );
    expect(accountsOnCalendar.has(card.id)).toBe(false);
    expect(cal.days.length).toBeLessThanOrEqual(calBefore.days.length);
    const merchantsDuring = (await c.h.call("get", "/api/merchants?limit=500").expect(200)).body
      .total;
    expect(merchantsDuring).toBeLessThanOrEqual(merchantsBefore);
    const recurring = (await c.h.call("get", "/api/insights/recurring").expect(200)).body;
    expect(JSON.stringify(recurring)).not.toContain(card.name);

    await hide(c, card.id, false).expect(200);
    expect(await txCount(c)).toBe(totalBefore);
    expect(await summary(c)).toEqual(spendBefore);
  });

  it("takes it out of the calendar's balance and debt figures", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    const q = "from=2026-08-10&to=2026-08-20";
    const before = (await c.h.call("get", `/api/calendar/summary?${q}`).expect(200)).body;
    expect(before.debt.accountsCounted).toBeGreaterThan(0);
    await hide(c, card.id).expect(200);
    const during = (await c.h.call("get", `/api/calendar/summary?${q}`).expect(200)).body;
    expect(during.debt).toMatchObject({ accountsCounted: 0, endMinor: null });
    expect(during.transactionCount).toBeLessThan(before.transactionCount);
  });

  it("keeps syncing a hidden account, so showing it again is up to date", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    await hide(c, card.id).expect(200);
    c.h.clock.now = new Date("2026-10-15T12:00:00Z");
    await c.h.sync.syncItem(c.itemId, "manual");
    const stillThere = (
      await c.h.call("get", `/api/transactions?pageSize=1&accountId=${card.id}`).expect(200)
    ).body.total;
    expect(stillThere).toBeGreaterThan(0);
    const all = (await c.h.call("get", "/api/accounts?includeHidden=1").expect(200)).body as Acct[];
    expect(all.find((a) => a.id === card.id)).toMatchObject({ hidden: true });
  });

  it("is kept in the JSON export, and the accounts export still lists it", async () => {
    const c = await synced();
    const card = c.accounts.find((a) => a.type === "credit")!;
    await hide(c, card.id).expect(200);
    const res = (await c.h.call("post", "/api/exports").send({ kind: "everything" }).expect(201))
      .body;
    const fs = await import("node:fs");
    const data = JSON.parse(fs.readFileSync(res.path, "utf8"));
    expect(data.accounts.find((a: { id: number }) => a.id === card.id)).toMatchObject({
      hidden: true,
    });
  });
});
