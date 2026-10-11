import { afterEach, describe, expect, it } from "vitest";
import { matchTransfers } from "./services/transfer.service.js";
import { makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * Checking, savings and a PayPal-like balance, all kept by hand so every transaction is known: $100
 * leaves checking and arrives in savings (an automatic match), and $100 also arrives in PayPal.
 */
async function setup() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const account = async (name: string, kind: string) =>
    (await h.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const add = async (
    accountId: number,
    merchant: string,
    direction: "in" | "out",
    date = "2026-03-02",
    amountMinor = 10_000,
  ) =>
    (
      await h
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction })
        .expect(201)
    ).body.id as number;
  const checking = await account("Checking", "checking");
  const savings = await account("Savings", "savings");
  const paypal = await account("PayPal", "checking");
  const out = await add(checking, "Online transfer to savings", "out");
  const intoSavings = await add(savings, "Transfer from checking", "in", "2026-03-03");
  const intoPaypal = await add(paypal, "Money added", "in", "2026-03-04");
  const tx = async (id: number) =>
    (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
  const pair = (id: number, otherId: number, status = 200) =>
    h.call("post", `/api/transactions/${id}/transfer-pair`).send({ otherId }).expect(status);
  const unmatched = async () =>
    (
      (await h.call("get", "/api/transactions?transfer=unmatched").expect(200)).body
        .items as Array<{
        id: number;
      }>
    ).map((t) => t.id);
  return { h, add, checking, savings, paypal, out, intoSavings, intoPaypal, tx, pair, unmatched };
}

describe("choosing the other side of a transfer", () => {
  it("suggests transactions going the other way, the exact amount and nearest first", async () => {
    const { h, add, savings, out, intoSavings, intoPaypal } = await setup();
    const near = await add(savings, "Interest", "in", "2026-03-02", 9_000);
    await add(savings, "Too late", "in", "2026-04-30");
    await add(savings, "Same direction", "out");
    const body = (await h.call("get", `/api/transactions/${out}/transfer-candidates`).expect(200))
      .body as Array<{ transaction: { id: number }; exactAmount: boolean; daysApart: number }>;
    expect(body.map((c) => c.transaction.id)).toEqual([intoSavings, intoPaypal, near]);
    expect(body[0]).toMatchObject({ exactAmount: true, daysApart: 1 });
    expect(body[2]).toMatchObject({ exactAmount: false });
  });

  it("replaces a wrong automatic match, releasing the old partner", async () => {
    const { out, intoSavings, intoPaypal, tx, pair, unmatched } = await setup();
    expect((await tx(out)).transferWith?.id).toBe(intoSavings);

    const fixed = (await pair(out, intoPaypal)).body;
    expect(fixed).toMatchObject({ isTransfer: true, transferSource: "manual" });
    expect(fixed.transferWith).toMatchObject({ id: intoPaypal, accountName: "PayPal" });
    expect((await tx(intoPaypal)).transferWith?.id).toBe(out);
    // The old partner is no longer a transfer: nothing else matches it.
    expect(await tx(intoSavings)).toMatchObject({ isTransfer: false, transferWith: null });
    expect(await unmatched()).toEqual([]);
  });

  it("confirming a match keeps it, and it survives detection", async () => {
    const { h, add, checking, out, intoSavings, tx } = await setup();
    await h.call("patch", `/api/transactions/${out}`).send({ isTransfer: true }).expect(200);
    for (const id of [out, intoSavings]) {
      expect(await tx(id)).toMatchObject({ isTransfer: true, transferSource: "manual" });
    }
    await add(checking, "Coffee", "out", "2026-03-05", 500); // runs detection again
    expect((await tx(out)).transferWith?.id).toBe(intoSavings);
    // Saying yes again leaves the link as it is.
    await h.call("patch", `/api/transactions/${out}`).send({ isTransfer: true }).expect(200);
    expect((await tx(out)).transferWith?.id).toBe(intoSavings);
  });

  it("unlinks a pair into two one-sided transfers, listed as unmatched", async () => {
    const { h, out, intoPaypal, tx, pair, unmatched } = await setup();
    await pair(out, intoPaypal);
    const after = (await h.call("delete", `/api/transactions/${out}/transfer-pair`).expect(200))
      .body;
    expect(after).toMatchObject({ isTransfer: true, transferSource: "manual", transferWith: null });
    expect(await tx(intoPaypal)).toMatchObject({ isTransfer: true, transferWith: null });
    expect((await unmatched()).sort()).toEqual([out, intoPaypal].sort());
    // Either can then be paired with the right one.
    await pair(intoPaypal, out);
    expect(await unmatched()).toEqual([]);
  });

  it("re-pairing a transfer linked to a hand-kept account removes what the link added", async () => {
    const { h, add, savings, out, intoPaypal, tx, pair } = await setup();
    const wallet = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id as number;
    await h.call("delete", `/api/transactions/${out}/transfer-pair`).expect(200);
    const linked = (
      await h
        .call("post", `/api/transactions/${out}/transfer-account`)
        .send({ accountId: wallet })
        .expect(200)
    ).body;
    const added = linked.transferWith.id as number;
    // The added side can't be paired with something else, only unlinked.
    await pair(added, await add(savings, "Out of savings", "out"), 409);
    await pair(out, intoPaypal);
    await h.call("get", `/api/transactions/${added}`).expect(404);
    expect((await tx(out)).transferWith?.id).toBe(intoPaypal);
  });

  it("never leaves a link pointing at a transaction that is gone", async () => {
    const { h, add, checking, out, intoPaypal, tx, pair, unmatched } = await setup();
    await pair(out, intoPaypal);
    // As a sync does when the bank drops a transaction.
    h.sqlite.prepare("delete from transactions where id = ?").run(intoPaypal);
    await add(checking, "Coffee", "out", "2026-03-05", 500); // runs detection again
    expect(await tx(out)).toMatchObject({ isTransfer: true, transferWith: null });
    expect(await unmatched()).toContain(out);
  });

  it("refuses pairs that cannot be one transfer", async () => {
    const { add, checking, savings, out, pair } = await setup();
    await pair(out, await add(savings, "Also out", "out"), 400);
    await pair(out, await add(checking, "Same account", "in"), 400);
    await pair(out, out, 400);
  });
});

describe("transfer words", () => {
  it("does not take T-Mobile for mobile banking", () => {
    const c = (id: number, accountId: number, amount: number, name: string) => ({
      id,
      accountId,
      date: "2026-01-01",
      amount,
      currency: "USD",
      category: null,
      name,
    });
    expect(
      matchTransfers([c(1, 1, 8000, "T-MOBILE AUTOPAY"), c(2, 2, -8000, "REFUND T-MOBILE")]),
    ).toEqual([]);
    expect(
      matchTransfers([c(1, 1, 8000, "MOBILE TRANSFER TO SAV"), c(2, 2, -8000, "DEPOSIT")]),
    ).toEqual([[1, 2]]);
  });
});
