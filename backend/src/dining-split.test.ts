import { afterEach, describe, expect, it } from "vitest";
import { ensureDiningSplit, seedDefaults } from "./services/category.service.js";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Tx {
  id: number;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  online: boolean;
  category: { id: number; name: string; source: string } | null;
}

async function setup() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const bank = await linkDemoBank(h.call);
  await h.sync.syncItem(bank.item.id, "manual");
  seedDefaults(h.db);
  const list = async () =>
    (await h.call("get", "/api/transactions?pageSize=200").expect(200)).body.items as Tx[];
  const food = (txs: Tx[]) =>
    txs.filter(
      (t) =>
        t.categoryPrimary === "FOOD_AND_DRINK" && t.categoryDetailed !== "FOOD_AND_DRINK_GROCERIES",
    );
  return { h, list, food };
}

describe("Food & Drink and Dining Out", () => {
  it("files online food orders under Food & Drink and in-person ones under Dining Out", async () => {
    const { h, list, food } = await setup();
    // Make sure there is at least one of each.
    const sample = food(await list());
    expect(sample.length).toBeGreaterThan(1);
    h.sqlite
      .prepare("UPDATE transactions SET payment_channel = 'online' WHERE id = ?")
      .run(sample[0]!.id);
    h.sqlite
      .prepare("UPDATE transactions SET payment_channel = 'in store' WHERE id = ?")
      .run(sample[1]!.id);

    expect(ensureDiningSplit(h.db)).toBeGreaterThan(0);
    expect(ensureDiningSplit(h.db)).toBeNull(); // only once

    const after = food(await list());
    for (const t of after) {
      expect(t.category?.name).toBe(t.online ? "Food & Drink" : "Dining Out");
    }
    const cats = (await h.call("get", "/api/categories").expect(200)).body as Array<{
      id: number;
      name: string;
      parentId: number | null;
    }>;
    const parent = cats.find((c) => c.name === "Food & Drink")!;
    expect(cats.find((c) => c.name === "Dining Out")!.parentId).toBe(parent.id);
  });

  it("moves a purchase when its online box is ticked or cleared, even with a category chosen by hand", async () => {
    const { h, list, food } = await setup();
    ensureDiningSplit(h.db);
    const t = food(await list()).find((x) => !x.online)!;
    expect(t.category?.name).toBe("Dining Out");

    const ticked = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ online: true }).expect(200)
    ).body as Tx;
    expect(ticked.category?.name).toBe("Food & Drink");

    // Chosen by hand: Dining Out. Ticking online still moves it to Food & Drink, and back.
    const dining = (await h.call("get", "/api/categories").expect(200)).body.find(
      (c: { name: string }) => c.name === "Dining Out",
    ).id as number;
    await h
      .call("patch", `/api/transactions/${t.id}`)
      .send({ online: false, categoryId: dining })
      .expect(200);
    const manual = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ online: true }).expect(200)
    ).body as Tx;
    expect(manual.category).toMatchObject({ name: "Food & Drink", source: "manual" });
    const back = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ online: false }).expect(200)
    ).body as Tx;
    expect(back.category?.name).toBe("Dining Out");
  });

  it("keeps the bank's answer, and forgets the user's once it matches the bank's again", async () => {
    const { h, list } = await setup();
    const t = (await list())[0]!;
    h.sqlite.prepare("UPDATE transactions SET payment_channel = 'in store' WHERE id = ?").run(t.id);
    const set = async (online: boolean) =>
      (await h.call("patch", `/api/transactions/${t.id}`).send({ online }).expect(200)).body as {
        online: boolean;
        onlineEdited: boolean;
        providerOnline: boolean | null;
      };
    expect(await set(true)).toMatchObject({
      online: true,
      onlineEdited: true,
      providerOnline: false,
    });
    expect(await set(false)).toMatchObject({
      online: false,
      onlineEdited: false,
      providerOnline: false,
    });
    const stored = h.sqlite
      .prepare(
        "SELECT online_user AS user, payment_channel AS channel FROM transactions WHERE id = ?",
      )
      .get(t.id);
    expect(stored).toEqual({ user: null, channel: "in store" });
  });

  it("leaves other categories alone when the box changes", async () => {
    const { h, list } = await setup();
    ensureDiningSplit(h.db);
    const other = (await list()).find((x) => x.category && x.categoryPrimary !== "FOOD_AND_DRINK")!;
    const res = (
      await h.call("patch", `/api/transactions/${other.id}`).send({ online: true }).expect(200)
    ).body as Tx;
    expect(res.category?.name).toBe(other.category!.name);
  });
});
