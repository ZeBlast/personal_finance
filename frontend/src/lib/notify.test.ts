import { describe, expect, it } from "vitest";
import { rememberSeen, unseen } from "./notify";

describe("showing each reminder once", () => {
  it("leaves out reminders already shown", () => {
    const due = [{ id: "bill:2026-11-02:card_bill:3" }, { id: "budget:2026-11:9:near" }];
    expect(unseen(due, ["budget:2026-11:9:near"]).map((r) => r.id)).toEqual([
      "bill:2026-11-02:card_bill:3",
    ]);
  });

  it("remembers the newest, keeping the list short", () => {
    expect(rememberSeen(["a", "b"], ["c"], 2)).toEqual(["b", "c"]);
  });
});
