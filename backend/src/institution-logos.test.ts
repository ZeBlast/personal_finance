import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("institution logos", () => {
  it("are looked up when a bank is linked, stored, and listed", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const linked = await linkDemoBank(t.call);
    const list = (await t.call("get", "/api/institutions").expect(200)).body as Array<{
      itemId: number;
      institutionName: string;
      logo: string | null;
      color: string | null;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      itemId: linked.item.id,
      institutionName: "First Platypus Bank",
    });
    expect(list[0]!.logo).toMatch(/^data:image\//);
    expect(list[0]!.color).toMatch(/^#[0-9a-f]{6}$/i);
    const stored = t.sqlite
      .prepare("SELECT branding_checked_at AS checked FROM plaid_items WHERE id = ?")
      .get(linked.item.id) as { checked: string | null };
    expect(stored.checked).not.toBeNull();
  });
});
