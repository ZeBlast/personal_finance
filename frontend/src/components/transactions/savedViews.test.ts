import { describe, expect, it } from "vitest";
import { withView } from "./SavedViews";

describe("saved views on Activity", () => {
  it("adds a view, and saving one of the same name replaces it", () => {
    const a = { name: "Cards", filters: { q: "" }, sort: "txdate_desc" };
    const b = { name: "Big ones", filters: { q: "" }, sort: "amount_desc" };
    const views = withView(withView([], a), b);
    expect(views.map((v) => v.name)).toEqual(["Cards", "Big ones"]);
    const again = withView(views, { ...a, name: " cards ", sort: "amount_asc" });
    expect(again.map((v) => [v.name, v.sort])).toEqual([
      ["Big ones", "amount_desc"],
      [" cards ", "amount_asc"],
    ]);
  });
});
