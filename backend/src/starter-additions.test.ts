import { afterEach, describe, expect, it } from "vitest";
import { categories } from "../../drizzle/schema.js";
import { ensureStarterAdditions, seedDefaults } from "./services/category.service.js";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Tx {
  id: number;
  merchant: string;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  category: { name: string; source: string } | null;
}

/** A database as an earlier version left it: the original starting set, with transactions. */
async function earlier() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const bank = await linkDemoBank(h.call);
  await h.sync.syncItem(bank.item.id, "manual");
  seedDefaults(h.db);
  const list = async () =>
    (await h.call("get", "/api/transactions?pageSize=200").expect(200)).body.items as Tx[];
  return { h, list };
}

describe("the Gas and Streaming categories", () => {
  it("are added with their rules, and past transactions move into them", async () => {
    const { h, list } = await earlier();
    const before = await list();
    const gas = before.filter((t) => t.categoryDetailed === "TRANSPORTATION_GAS");
    const streaming = before.filter((t) => t.categoryDetailed === "ENTERTAINMENT_TV_AND_MOVIES");
    expect(gas.length).toBeGreaterThan(0);
    expect(streaming.length).toBeGreaterThan(0);
    // Before: they sit in the broad categories.
    expect(gas.every((t) => t.category?.name === "Transportation")).toBe(true);
    expect(streaming.every((t) => t.category?.name === "Entertainment")).toBe(true);

    const result = ensureStarterAdditions(h.db)!;
    expect(result).toMatchObject({ categoriesCreated: 2 });
    expect(result.rulesCreated).toBeGreaterThanOrEqual(3);
    expect(result.recategorized).toBe(gas.length + streaming.length);

    const after = await list();
    for (const t of after.filter((x) => x.categoryDetailed === "TRANSPORTATION_GAS")) {
      expect(t.category).toMatchObject({ name: "Gas", source: "rule" });
    }
    for (const t of after.filter((x) => x.categoryDetailed === "ENTERTAINMENT_TV_AND_MOVIES")) {
      expect(t.category).toMatchObject({ name: "Streaming", source: "rule" });
    }
    // Other transportation (not gas) stays where it was.
    const names = new Set(
      after.filter((t) => t.categoryPrimary === "TRANSPORTATION").map((t) => t.category?.name),
    );
    expect(names.has("Transportation") || names.size === 1).toBe(true);
  });

  it("never move a transaction the user categorized by hand", async () => {
    const { h, list } = await earlier();
    const gas = (await list()).find((t) => t.categoryDetailed === "TRANSPORTATION_GAS")!;
    const other = h.sqlite.prepare("SELECT id FROM categories WHERE name = 'Shopping'").get() as {
      id: number;
    };
    await h.call("patch", `/api/transactions/${gas.id}`).send({ categoryId: other.id }).expect(200);
    ensureStarterAdditions(h.db);
    const after = (await list()).find((t) => t.id === gas.id)!;
    expect(after.category).toMatchObject({ name: "Shopping", source: "manual" });
  });

  it("run once: a second call does nothing, and deleting them later does not bring them back", async () => {
    const { h } = await earlier();
    expect(ensureStarterAdditions(h.db)).not.toBeNull();
    expect(ensureStarterAdditions(h.db)).toBeNull();
    const gasId = (
      h.sqlite.prepare("SELECT id FROM categories WHERE name = 'Gas'").get() as { id: number }
    ).id;
    await h.call("delete", `/api/categories/${gasId}`).expect(200);
    expect(ensureStarterAdditions(h.db)).toBeNull();
    // A category that has transactions is archived rather than erased: it is not made again.
    const gas = h.db
      .select()
      .from(categories)
      .all()
      .filter((c) => c.name === "Gas");
    expect(gas.length).toBeLessThanOrEqual(1);
    expect(gas.some((c) => c.active)).toBe(false);
    expect(
      h.db
        .select()
        .from(categories)
        .all()
        .map((c) => c.name),
    ).toContain("Streaming");
  });

  it("use a category of the same name the user already has, rather than making a second", async () => {
    const { h, list } = await earlier();
    await h.call("post", "/api/categories").send({ name: "gas" }).expect(201);
    const result = ensureStarterAdditions(h.db)!;
    expect(result.categoriesCreated).toBe(1); // only Streaming
    const gasCategories = h.sqlite
      .prepare("SELECT COUNT(*) AS n FROM categories WHERE lower(name) = 'gas'")
      .get();
    expect(gasCategories).toEqual({ n: 1 });
    const gas = (await list()).find((t) => t.categoryDetailed === "TRANSPORTATION_GAS")!;
    expect(gas.category?.name.toLowerCase()).toBe("gas");
  });

  it("also catch well-known streaming services by merchant name, on new transactions", async () => {
    const { h } = await earlier();
    ensureStarterAdditions(h.db);
    const account = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const add = async (merchant: string) =>
      (
        await h
          .call("post", "/api/transactions")
          .send({
            accountId: account,
            date: "2026-09-10",
            merchant,
            amountMinor: 1599,
            direction: "out",
          })
          .expect(201)
      ).body as Tx;
    expect((await add("HULU 877-8244858")).category?.name).toBe("Streaming");
    expect((await add("Spotify USA")).category?.name).toBe("Streaming");
    expect((await add("Corner Cafe")).category?.name).not.toBe("Streaming");
  });
});
