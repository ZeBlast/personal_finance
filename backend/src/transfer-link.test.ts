import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const { item } = await linkDemoBank(h.call);
  await h.sync.syncItem(item.id, "manual");
  const make = async (name: string, kind: string) =>
    (await h.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const wallet = await make("Wallet", "cash");
  // Money that left a bank account and matched nothing (an ATM withdrawal, say).
  const out = h.sqlite
    .prepare(
      "select id, amount_minor as amount from transactions where amount_minor > 0 and transfer_pair_id is null and source = 'plaid' order by id limit 1",
    )
    .get() as { id: number; amount: number };
  const balance = async (id: number) =>
    (
      (await h.call("get", "/api/accounts").expect(200)).body as Array<{
        id: number;
        currentBalanceMinor: number;
      }>
    ).find((a) => a.id === id)!.currentBalanceMinor;
  const tx = async (id: number) =>
    (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
  return { h, make, wallet, out, balance, tx };
}

describe("linking a transfer with a hand-kept account", () => {
  it("adds the other side there, pairs the two, and moves the balance", async () => {
    const { h, wallet, out, balance, tx } = await setup();
    const linked = (
      await h
        .call("post", `/api/transactions/${out.id}/transfer-account`)
        .send({ accountId: wallet })
        .expect(200)
    ).body;
    expect(linked).toMatchObject({ isTransfer: true, transferSource: "manual" });
    expect(linked.transferWith).toMatchObject({ accountName: "Wallet" });
    expect(await balance(wallet)).toBe(out.amount);

    const other = await tx(linked.transferWith.id);
    expect(other).toMatchObject({
      accountName: "Wallet",
      amountMinor: -out.amount,
      isTransfer: true,
      createdForTransfer: true,
    });
    expect(other.transferWith.id).toBe(out.id);

    // A sync's transfer detection leaves a link made by hand alone.
    await h.sync.syncItem(
      (h.sqlite.prepare("select id from plaid_items limit 1").get() as { id: number }).id,
      "manual",
    );
    expect((await tx(out.id)).transferWith?.id).toBe(other.id);

    // Linking again is refused; so is changing the transfer flag while linked.
    await h
      .call("post", `/api/transactions/${out.id}/transfer-account`)
      .send({ accountId: wallet })
      .expect(409);
    await h.call("patch", `/api/transactions/${out.id}`).send({ isTransfer: null }).expect(409);
  });

  it("unlinks, removing what it added and the balance it moved", async () => {
    const { h, wallet, out, balance } = await setup();
    const linked = (
      await h
        .call("post", `/api/transactions/${out.id}/transfer-account`)
        .send({ accountId: wallet })
        .expect(200)
    ).body;
    const kept = (
      await h.call("delete", `/api/transactions/${out.id}/transfer-account`).expect(200)
    ).body;
    expect(kept).toMatchObject({ id: out.id, isTransfer: true, transferWith: null });
    expect(await balance(wallet)).toBe(0);
    await h.call("get", `/api/transactions/${linked.transferWith.id}`).expect(404);
    // It can be linked again.
    await h
      .call("post", `/api/transactions/${out.id}/transfer-account`)
      .send({ accountId: wallet })
      .expect(200);
  });

  it("deleting the added side leaves the bank side a transfer, unlinked", async () => {
    const { h, wallet, out, balance, tx } = await setup();
    const linked = (
      await h
        .call("post", `/api/transactions/${out.id}/transfer-account`)
        .send({ accountId: wallet })
        .expect(200)
    ).body;
    await h.call("delete", `/api/transactions/${linked.transferWith.id}`).expect(204);
    expect(await tx(out.id)).toMatchObject({ isTransfer: true, transferWith: null });
    expect(await balance(wallet)).toBe(0);
  });

  it("only links with a hand-kept account that holds transactions", async () => {
    const { h, make, out } = await setup();
    const cards = await make("Cards", "pokemon_cards");
    const giftCard = await make("Dunkin", "store_credit");
    const bank = (
      h.sqlite.prepare("select account_id as id from transactions where id = ?").get(out.id) as {
        id: number;
      }
    ).id;
    for (const accountId of [cards, giftCard]) {
      await h
        .call("post", `/api/transactions/${out.id}/transfer-account`)
        .send({ accountId })
        .expect(409);
    }
    await h
      .call("post", `/api/transactions/${out.id}/transfer-account`)
      .send({ accountId: bank })
      .expect(400);
  });
});

describe("a transfer linked by hand, in the list", () => {
  it("shows the added side after the original in time, in every date order", async () => {
    const { h, wallet, out } = await setup();
    const linked = (
      await h
        .call("post", `/api/transactions/${out.id}/transfer-account`)
        .send({ accountId: wallet })
        .expect(200)
    ).body;
    const added = linked.transferWith.id as number;
    for (const sort of ["txdate_desc", "date_desc", "txdate_asc", "date_asc"]) {
      const items = (await h.call("get", `/api/transactions?pageSize=200&sort=${sort}`).expect(200))
        .body.items as Array<{ id: number }>;
      const at = items.findIndex((t) => t.id === out.id);
      expect(at, sort).toBeGreaterThanOrEqual(0);
      // It happened after: above the original when the newest is first, below when the oldest is.
      const newestFirst = sort.endsWith("_desc");
      expect(items[newestFirst ? at - 1 : at + 1]?.id, sort).toBe(added);
    }
  });
});
