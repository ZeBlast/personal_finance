import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";
import { openFolder, openedFolders } from "./utils/open-folder.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("merchant groups", () => {
  it("count several merchants as one, every spelling included, in the network", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    const g0 = (
      await h.call("get", "/api/graph/transactions?from=2000-01-01&to=2030-12-31").expect(200)
    ).body;
    const names = [
      ...new Set(g0.transactions.map((t: { merchant: string }) => t.merchant)),
    ] as string[];
    const [a, b] = names;
    const made = (
      await h
        .call("post", "/api/merchant-groups")
        .send({ name: "Errands", merchants: [a, `${b} #12345`] })
        .expect(201)
    ).body;
    expect(made.name).toBe("Errands");
    expect(made.merchants).toHaveLength(2);

    const g = (
      await h.call("get", "/api/graph/transactions?from=2000-01-01&to=2030-12-31").expect(200)
    ).body;
    for (const t of g.transactions as Array<{ merchant: string; merchantGroup: string | null }>) {
      expect(t.merchantGroup).toBe(t.merchant === a || t.merchant === b ? "Errands" : null);
    }

    // A merchant moves to the group it is added to last; an emptied group goes away.
    await h
      .call("post", "/api/merchant-groups")
      .send({ name: "Other", merchants: [a, b] })
      .expect(201);
    const groups = (await h.call("get", "/api/merchant-groups").expect(200)).body;
    expect(groups.map((x: { name: string }) => x.name)).toEqual(["Other"]);
    await h.call("delete", `/api/merchant-groups/${groups[0].id}`).expect(204);
    expect((await h.call("get", "/api/merchant-groups").expect(200)).body).toEqual([]);
  });

  it("group transactions added by hand and imported, like bank ones", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const account = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const byHand = (
      await h
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: "2026-09-01",
          merchant: "Corner Store",
          amountMinor: 500,
          direction: "out",
        })
        .expect(201)
    ).body.id as number;
    await h
      .call("post", `/api/accounts/manual/${account}/import-csv`)
      .send({ csv: "Date,Description,Amount\n09/02/2026,CORNER STORE #1234,-3.00" })
      .expect(200);

    await h
      .call("put", "/api/merchant-groups/membership")
      .send({ merchant: "Corner Store", newGroup: "Snacks" })
      .expect(200);
    const items = (await h.call("get", `/api/transactions?accountId=${account}`).expect(200)).body
      .items as Array<{ id: number; merchant: string; merchantOriginal: string }>;
    expect(items.find((t) => t.id === byHand)).toMatchObject({
      merchant: "Snacks",
      merchantOriginal: "Corner Store",
    });
    // The imported spelling, with its store number, is the same merchant.
    expect(items.find((t) => t.id !== byHand)).toMatchObject({ merchant: "Snacks" });
  });

  it("need a name and merchants", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t
      .call("post", "/api/merchant-groups")
      .send({ name: " ", merchants: ["A"] })
      .expect(400);
    await t.call("post", "/api/merchant-groups").send({ name: "X", merchants: [] }).expect(400);
  });
});

describe("opening a folder", () => {
  it("always opens the full path, even from a relative one", () => {
    // A relative path to a folder in the temp directory, as a data folder set as ../data would be.
    const target = path.join(os.tmpdir(), "pf-open-folder-test");
    openFolder(path.relative(process.cwd(), target));
    expect(openedFolders.at(-1)).toBe(target);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe("merchant groups on transactions", () => {
  it("show the group's name, keep the merchant's own, and are managed one merchant at a time", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    const list = async (q = "") =>
      (
        await h
          .call("get", `/api/transactions?pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ""}`)
          .expect(200)
      ).body.items as Array<{
        id: number;
        merchant: string;
        merchantOriginal: string;
        merchantGroup: { id: number; name: string } | null;
      }>;
    const before = await list();
    const [a, b] = [...new Set(before.map((t) => t.merchant))];

    // Into a new group, then a second merchant into the same group.
    const made = (
      await h
        .call("put", "/api/merchant-groups/membership")
        .send({ merchant: a, newGroup: "Errands" })
        .expect(200)
    ).body;
    const errands = made.find((g: { name: string }) => g.name === "Errands");
    await h
      .call("put", "/api/merchant-groups/membership")
      .send({ merchant: b, groupId: errands.id })
      .expect(200);

    const after = await list();
    for (const t of after) {
      if (t.merchantOriginal === a || t.merchantOriginal === b) {
        expect(t).toMatchObject({
          merchant: "Errands",
          merchantGroup: { id: errands.id, name: "Errands" },
        });
      } else {
        expect(t.merchant).toBe(t.merchantOriginal);
        expect(t.merchantGroup).toBeNull();
      }
    }
    // One transaction, opened on its own, shows the same.
    const one = after.find((t) => t.merchantOriginal === a)!;
    expect((await h.call("get", `/api/transactions/${one.id}`).expect(200)).body).toMatchObject({
      merchant: "Errands",
      merchantOriginal: a,
    });

    // Searching for the group's name finds its merchants' transactions.
    const found = await list("Errands");
    expect(found.length).toBe(after.filter((t) => t.merchantGroup).length);

    // Out of the group; the last one out removes the group.
    await h
      .call("put", "/api/merchant-groups/membership")
      .send({ merchant: a, groupId: null })
      .expect(200);
    const left = (
      await h
        .call("put", "/api/merchant-groups/membership")
        .send({ merchant: b, groupId: null })
        .expect(200)
    ).body;
    expect(left).toEqual([]);
    expect((await list()).every((t) => t.merchantGroup === null)).toBe(true);
  });

  it("can be renamed", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const [g] = (
      await t
        .call("put", "/api/merchant-groups/membership")
        .send({ merchant: "AMZN Mktp", newGroup: "Amzn" })
        .expect(200)
    ).body;
    const renamed = (
      await t.call("patch", `/api/merchant-groups/${g.id}`).send({ name: "Amazon" }).expect(200)
    ).body;
    expect(renamed[0].name).toBe("Amazon");
  });
});
