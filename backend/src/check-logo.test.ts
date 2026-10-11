import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("checking a connection", () => {
  it("looks up the institution's logo when it has none, and lists it", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const { item } = await linkDemoBank(t.call);
    t.sqlite.prepare("update plaid_items set institution_logo = null where id = ?").run(item.id);
    const listed = (await t.call("get", "/api/plaid/items").expect(200)).body;
    expect(listed[0].logo).toBeNull();
    const checked = (await t.call("post", `/api/plaid/items/${item.id}/check`).expect(200)).body;
    expect(checked.logo).toMatch(/^data:image\//);
    expect((await t.call("get", "/api/plaid/items").expect(200)).body[0].logo).toBe(checked.logo);
  });
});
