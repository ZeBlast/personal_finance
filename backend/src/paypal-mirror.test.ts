import { afterEach, describe, expect, it } from "vitest";
import { matchMirrors, namesAgree } from "./services/paypal-mirror.service.js";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("matching a PayPal purchase with the charge that paid it", () => {
  const row = (id: number, accountId: number, date: string, amount: number, text: string) => ({
    id,
    accountId,
    date,
    amount,
    currency: "USD",
    text,
  });

  it("compares merchant names the way the bank and PayPal write them", () => {
    expect(namesAgree("Payment to Whatnot Inc", "WHATNOT INC")).toBe(true);
    expect(namesAgree("McDonald's", "MCDONALD'S F12345")).toBe(true);
    expect(namesAgree("Spotify", "Spotify USA")).toBe(true);
    expect(namesAgree("DoorDash", "Bojangles")).toBe(false);
    expect(namesAgree("Payment to Valve Corp.", "Venmo")).toBe(false);
  });

  it("links on the same amount, a few days later, and the same merchant; the card counts", () => {
    const paypal = [row(1, 9, "2026-03-01", 1234, "Payment to Whatnot Inc")];
    const card = [
      row(2, 5, "2026-03-02", 1234, "WHATNOT INC"),
      row(3, 5, "2026-03-02", 1234, "Bojangles"), // same amount, another merchant
    ];
    expect(matchMirrors(paypal, card)).toEqual([{ copy: 1, counts: 2 }]);
  });

  it("lets the PayPal row count when the bank only says PayPal", () => {
    const paypal = [row(1, 9, "2026-02-09", 2000, "FanDuel Sportsbook")];
    const bank = [row(2, 5, "2026-02-09", 2000, "PAYPAL DES:INST XFER ID:GAMINGFUND")];
    expect(matchMirrors(paypal, bank)).toEqual([{ copy: 2, counts: 1 }]);
  });

  it("leaves alone different amounts, other directions, and charges too far apart", () => {
    const paypal = [row(1, 9, "2026-03-01", 1234, "Spotify")];
    expect(matchMirrors(paypal, [row(2, 5, "2026-03-01", 1235, "Spotify")])).toEqual([]);
    expect(matchMirrors(paypal, [row(2, 5, "2026-03-06", 1234, "Spotify")])).toEqual([]);
    expect(matchMirrors(paypal, [row(2, 5, "2026-02-27", 1234, "Spotify")])).toEqual([]);
    expect(
      matchMirrors(
        [row(1, 9, "2026-03-01", -1234, "Spotify")],
        [row(2, 5, "2026-03-01", -1234, "Spotify")],
      ),
    ).toEqual([]);
  });

  it("uses each charge once, so two equal purchases take two charges", () => {
    const paypal = [
      row(1, 9, "2026-03-01", 635, "Spotify"),
      row(2, 9, "2026-04-01", 635, "Spotify"),
    ];
    const card = [row(3, 5, "2026-03-01", 635, "Spotify"), row(4, 5, "2026-04-02", 635, "Spotify")];
    expect(matchMirrors(paypal, card)).toEqual([
      { copy: 1, counts: 3 },
      { copy: 2, counts: 4 },
    ]);
  });
});

/** PayPal and a card, kept by hand so every transaction is known. */
async function setup() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const account = async (name: string, kind: string) =>
    (await h.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const add = async (accountId: number, merchant: string, date: string, amountMinor = 1234) =>
    (
      await h
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction: "out" })
        .expect(201)
    ).body.id as number;
  const paypal = await account("PayPal", "checking");
  const card = await account("Visa", "credit_card");
  const checking = await account("Checking", "checking");
  const tx = async (id: number) =>
    (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
  return { h, add, paypal, card, checking, tx };
}

describe("PayPal purchases paid with a card", () => {
  it("links them automatically: the PayPal row is a copy, left out like a transfer", async () => {
    const { add, paypal, card, tx } = await setup();
    const p = await add(paypal, "Payment to Whatnot Inc", "2026-03-01");
    const c = await add(card, "WHATNOT INC", "2026-03-02");
    expect(await tx(p)).toMatchObject({
      isTransfer: true,
      transferSource: "mirror",
      mirror: { role: "copy", source: "auto", with: { id: c, accountName: "Visa" } },
    });
    expect(await tx(c)).toMatchObject({
      isTransfer: false,
      mirror: { role: "counts", source: "auto", with: { id: p, accountName: "PayPal" } },
    });
  });

  it("keeps copies out of the transfers missing their other side", async () => {
    const { h, add, paypal, card } = await setup();
    await add(paypal, "Spotify", "2026-03-01", 635);
    await add(card, "Spotify", "2026-03-01", 635);
    const unmatched = (await h.call("get", "/api/transactions?transfer=unmatched").expect(200))
      .body;
    expect(unmatched.items).toEqual([]);
  });

  it("lets the PayPal row count when the bank only says PayPal", async () => {
    const { add, paypal, checking, tx } = await setup();
    const p = await add(paypal, "FanDuel Sportsbook", "2026-02-09", 2000);
    const b = await add(checking, "PAYPAL DES:INST XFER ID:GAMINGFUND", "2026-02-09", 2000);
    expect((await tx(b)).mirror).toMatchObject({ role: "copy", with: { id: p } });
    expect((await tx(p)).isTransfer).toBe(false);
  });

  it("unlinks for good: both count again, and detection leaves them apart", async () => {
    const { h, add, paypal, card, tx } = await setup();
    const p = await add(paypal, "Spotify", "2026-03-01", 635);
    const c = await add(card, "Spotify", "2026-03-01", 635);
    const after = (await h.call("delete", `/api/transactions/${c}/mirror`).expect(200)).body;
    expect(after.mirror).toBeNull();
    expect(await tx(p)).toMatchObject({ isTransfer: false, transferSource: null, mirror: null });
    await add(card, "Coffee", "2026-03-05", 500); // runs detection again
    expect((await tx(p)).mirror).toBeNull();
  });

  it("links by hand what detection would not, and suggests it first", async () => {
    const { h, add, paypal, card, tx } = await setup();
    const p = await add(paypal, "DoorDash", "2026-01-10", 1245);
    const c = await add(card, "Bojangles", "2026-01-11", 1245);
    expect((await tx(p)).mirror).toBeNull();
    const suggestions = (
      await h.call("get", `/api/transactions/${p}/mirror-candidates`).expect(200)
    ).body as Array<{ transaction: { id: number }; exactAmount: boolean }>;
    expect(suggestions[0]).toMatchObject({ transaction: { id: c }, exactAmount: true });

    const linked = (
      await h.call("post", `/api/transactions/${p}/mirror`).send({ otherId: c }).expect(200)
    ).body;
    expect(linked.mirror).toMatchObject({ role: "copy", source: "manual", with: { id: c } });
    // A copy's transfer flag can't be changed while it is linked.
    await h.call("patch", `/api/transactions/${p}`).send({ isTransfer: false }).expect(409);
  });

  it("refuses links that cannot be one purchase", async () => {
    const { h, add, paypal, card } = await setup();
    const p = await add(paypal, "Spotify", "2026-03-01", 635);
    const sameAccount = await add(paypal, "Other", "2026-03-01", 635);
    await h
      .call("post", `/api/transactions/${p}/mirror`)
      .send({ otherId: sameAccount })
      .expect(400);
    const refund = (
      await h
        .call("post", "/api/transactions")
        .send({
          accountId: card,
          date: "2026-03-01",
          merchant: "Refund",
          amountMinor: 635,
          direction: "in",
        })
        .expect(201)
    ).body.id as number;
    await h.call("post", `/api/transactions/${p}/mirror`).send({ otherId: refund }).expect(400);
  });
});

describe("PayPal transactions older than every other account's history", () => {
  it("are marked, so the list can gray them out", async () => {
    const { h, add, paypal, tx } = await setup();
    await linkDemoBank(h.call);
    const { item } = {
      item: h.sqlite.prepare("select id from plaid_items limit 1").get() as { id: number },
    };
    await h.sync.syncItem(item.id, "manual");
    const start = (
      h.sqlite
        .prepare(
          "select min(coalesce(authorized_date, date)) as d from transactions t join accounts a on a.id = t.account_id where a.plaid_item_id is not null",
        )
        .get() as { d: string }
    ).d;
    const old = await add(paypal, "Old purchase", "2020-01-01", 999);
    const recent = await add(paypal, "Recent purchase", start, 998);
    expect((await tx(old)).beforeOtherHistory).toBe(true);
    expect((await tx(recent)).beforeOtherHistory).toBe(false);
  });
});
