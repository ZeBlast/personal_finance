import { afterEach, describe, expect, it } from "vitest";
import { overview } from "./services/analytics.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const EXPORT = `1 Pikachu - 025/165 [MEW] 025/165
2 Charizard ex (Special Illustration Rare) - 199/165 [MEW] 199/165
1 Pikachu - 025/165 [MEW] 025/165
`;

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const id = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Pokemon cards", kind: "collection" })
      .expect(201)
  ).body.id as number;
  const balance = async () =>
    (
      (await t.call("get", "/api/accounts").expect(200)).body as Array<{
        id: number;
        currentBalanceMinor: number;
      }>
    ).find((a) => a.id === id)!.currentBalanceMinor;
  return { t, id, balance };
}

describe("collection accounts", () => {
  it("refuse an opening balance", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Cards", kind: "collection", openingBalanceMinor: 500 })
      .expect(400);
  });

  it("import a TCGPlayer export, with a preview that changes nothing", async () => {
    const { t, id } = await setup();
    const preview = (
      await t
        .call("post", `/api/accounts/${id}/collection/import`)
        .send({ text: EXPORT, preview: true })
        .expect(200)
    ).body;
    expect(preview).toMatchObject({ added: 2, updated: 0, collection: null });
    expect(
      (await t.call("get", `/api/accounts/${id}/collection`).expect(200)).body.items,
    ).toHaveLength(0);

    const done = (
      await t
        .call("post", `/api/accounts/${id}/collection/import`)
        .send({ text: EXPORT })
        .expect(200)
    ).body;
    expect(done.collection).toMatchObject({
      totalQuantity: 4,
      unvaluedItems: 2,
      totalValueMinor: 0,
    });
    const pikachu = done.collection.items.find((i: { name: string }) => i.name === "Pikachu");
    expect(pikachu).toMatchObject({ quantity: 2, setCode: "MEW", number: "025/165" });

    // Importing again sets quantities to the export's, it doesn't add them up.
    const again = (
      await t
        .call("post", `/api/accounts/${id}/collection/import`)
        .send({ text: EXPORT })
        .expect(200)
    ).body;
    expect(again).toMatchObject({ added: 0, updated: 2 });
    expect(again.collection.totalQuantity).toBe(4);
  });

  it("value items into the account balance and net worth, keeping values on reimport", async () => {
    const { t, id, balance } = await setup();
    const { collection } = (
      await t
        .call("post", `/api/accounts/${id}/collection/import`)
        .send({ text: EXPORT })
        .expect(200)
    ).body;
    const charizard = collection.items.find((i: { name: string }) => i.name === "Charizard ex");
    const { name, variant, setCode, number, quantity } = charizard;
    const fields = { name, variant, setCode, number, quantity };
    const updated = (
      await t
        .call("put", `/api/accounts/${id}/collection/items/${charizard.id}`)
        .send({ ...fields, unitValueMinor: 12_000 })
        .expect(200)
    ).body;
    expect(updated.totalValueMinor).toBe(24_000);
    expect(await balance()).toBe(24_000);
    expect(overview(t.db).netWorthMinor).toBe(24_000);

    await t
      .call("post", `/api/accounts/${id}/collection/import`)
      .send({ text: EXPORT })
      .expect(200);
    expect(await balance()).toBe(24_000);

    const after = (
      await t.call("delete", `/api/accounts/${id}/collection/items/${charizard.id}`).expect(200)
    ).body;
    expect(after.totalValueMinor).toBe(0);
    expect(await balance()).toBe(0);
  });

  it("add a card by hand, merging a repeat into its quantity", async () => {
    const { t, id } = await setup();
    const card = {
      name: "Mew",
      setCode: "MEW",
      number: "151/165",
      quantity: 1,
      unitValueMinor: 300,
    };
    await t.call("post", `/api/accounts/${id}/collection/items`).send(card).expect(201);
    const c = (await t.call("post", `/api/accounts/${id}/collection/items`).send(card).expect(201))
      .body;
    expect(c.items).toHaveLength(1);
    expect(c).toMatchObject({ totalQuantity: 2, totalValueMinor: 600 });
  });

  it("can be deleted, and other accounts are not collections", async () => {
    const { t, id } = await setup();
    const cash = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    await t.call("get", `/api/accounts/${cash}/collection`).expect(409);
    await t.call("delete", `/api/accounts/manual/${id}`).expect(204);
    await t.call("get", `/api/accounts/${id}/collection`).expect(404);
  });
});

describe("Pokemon card collections", () => {
  async function pokemon() {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const id = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Pokemon", kind: "pokemon_cards" })
        .expect(201)
    ).body.id as number;
    return { t, id };
  }
  const card = { name: "Mew", setCode: "MEW", number: "151/165", quantity: 1 };

  it("need a TCGplayer id to add a card, and default its condition to LP", async () => {
    const { t, id } = await pokemon();
    const missing = await t
      .call("post", `/api/accounts/${id}/collection/items`)
      .send(card)
      .expect(400);
    expect(missing.body.error).toBe("invalid_tcgplayer_id");
    await t
      .call("post", `/api/accounts/${id}/collection/items`)
      .send({ ...card, tcgplayerId: "abc" })
      .expect(400);
    const c = (
      await t
        .call("post", `/api/accounts/${id}/collection/items`)
        .send({ ...card, tcgplayerId: "502" })
        .expect(201)
    ).body;
    expect(c.type).toBe("pokemon");
    expect(c.items[0]).toMatchObject({ tcgplayerId: "502", condition: "LP" });
  });

  it("refuse an unknown condition, and keep conditions apart", async () => {
    const { t, id } = await pokemon();
    await t
      .call("post", `/api/accounts/${id}/collection/items`)
      .send({ ...card, tcgplayerId: "502", condition: "Mint-ish" })
      .expect(400);
    await t
      .call("post", `/api/accounts/${id}/collection/items`)
      .send({ ...card, tcgplayerId: "502" })
      .expect(201);
    const c = (
      await t
        .call("post", `/api/accounts/${id}/collection/items`)
        .send({ ...card, tcgplayerId: "502", condition: "nm" })
        .expect(201)
    ).body;
    expect(c.items.map((i: { condition: string }) => i.condition).sort()).toEqual(["LP", "NM"]);
  });

  it("keep the id and condition when an edit leaves them out", async () => {
    const { t, id } = await pokemon();
    const c = (
      await t
        .call("post", `/api/accounts/${id}/collection/items`)
        .send({ ...card, tcgplayerId: "502", condition: "MP" })
        .expect(201)
    ).body;
    const after = (
      await t
        .call("put", `/api/accounts/${id}/collection/items/${c.items[0].id}`)
        .send({ ...card, quantity: 3 })
        .expect(200)
    ).body;
    expect(after.items[0]).toMatchObject({ quantity: 3, tcgplayerId: "502", condition: "MP" });
  });

  it("are the only collections with market prices", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const other = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Stamps", kind: "collection" })
        .expect(201)
    ).body.id;
    expect((await t.call("get", `/api/accounts/${other}/collection`).expect(200)).body.type).toBe(
      "other",
    );
    await t.call("get", `/api/accounts/${other}/collection/prices/cost`).expect(409);
    await t.call("post", `/api/accounts/${other}/collection/prices/update`).send({}).expect(409);
    // Other collections take items without an id.
    await t
      .call("post", `/api/accounts/${other}/collection/items`)
      .send({ name: "Penny Black", quantity: 1 })
      .expect(201);
  });
});
