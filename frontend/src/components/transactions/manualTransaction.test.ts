import { describe, expect, it } from "vitest";
import type { Transaction } from "../../types/api";
import {
  buildManualPayload,
  draftFromTransaction,
  emptyManualDraft,
  type ManualDraft,
} from "./manualTransaction";

const draft = (over: Partial<ManualDraft> = {}): ManualDraft => ({
  ...emptyManualDraft("2026-10-05", "3"),
  merchant: "Corner Cafe",
  amount: "12.50",
  ...over,
});

describe("building a new transaction", () => {
  it("sends the essentials", () => {
    expect(buildManualPayload(draft(), "create")).toEqual({
      ok: true,
      payload: {
        accountId: 3,
        date: "2026-10-05",
        merchant: "Corner Cafe",
        amountMinor: 1250,
        direction: "out",
        pending: false,
        isTransfer: false,
      },
    });
  });

  it("puts the person in the field that matches the direction", () => {
    const out = buildManualPayload(draft({ person: " Cafe owner " }), "create");
    expect(out).toMatchObject({ ok: true, payload: { recipient: "Cafe owner" } });
    expect((out as { payload: Record<string, unknown> }).payload).not.toHaveProperty("sender");
    const into = buildManualPayload(draft({ direction: "in", person: "Alex" }), "create");
    expect(into).toMatchObject({ ok: true, payload: { sender: "Alex", direction: "in" } });
    expect((into as { payload: Record<string, unknown> }).payload).not.toHaveProperty("recipient");
  });

  it("includes the optional parts only when filled in", () => {
    const full = buildManualPayload(
      draft({
        description: " Lunch ",
        categoryId: "7",
        notes: " with Sam ",
        pending: true,
        isTransfer: true,
      }),
      "create",
    );
    expect(full).toMatchObject({
      ok: true,
      payload: {
        description: "Lunch",
        categoryId: 7,
        notes: "with Sam",
        pending: true,
        isTransfer: true,
      },
    });
  });

  it("explains each mistake", () => {
    const messages = [
      draft({ accountId: "" }),
      draft({ date: "" }),
      draft({ merchant: "  " }),
      draft({ amount: "" }),
      draft({ amount: "0" }),
      draft({ amount: "-5" }),
      draft({ amount: "1.234" }),
      draft({ amount: "abc" }),
    ].map((d) => buildManualPayload(d, "create"));
    for (const m of messages) expect(m.ok).toBe(false);
    expect((messages[0] as { message: string }).message).toMatch(/account/);
    expect((messages[2] as { message: string }).message).toMatch(/who the payment/);
    expect((messages[5] as { message: string }).message).toMatch(/positive/);
  });

  it("accepts dollar signs and thousands separators", () => {
    expect(buildManualPayload(draft({ amount: "$1,234.50" }), "create")).toMatchObject({
      payload: { amountMinor: 123450 },
    });
  });
});

describe("saving an edit", () => {
  it("sends the transfer flag only when the box was changed", () => {
    const same = buildManualPayload(draft({ isTransfer: true }), "edit", true);
    expect(same).toMatchObject({ ok: true });
    expect(same.ok && "isTransfer" in same.payload).toBe(false);
    const changed = buildManualPayload(draft({ isTransfer: false }), "edit", true);
    expect(changed.ok && changed.payload["isTransfer"]).toBe(false);
  });

  it("sends every field so a cleared box really clears", () => {
    const result = buildManualPayload(draft({ person: "", notes: "", categoryId: "" }), "edit");
    expect(result).toEqual({
      ok: true,
      payload: {
        accountId: 3,
        date: "2026-10-05",
        merchant: "Corner Cafe",
        amountMinor: 1250,
        direction: "out",
        pending: false,
        isTransfer: false,
        categoryId: null,
        recipient: null,
        sender: null,
        notes: null,
      },
    });
  });

  it("clears the person that no longer fits when the direction changes", () => {
    const flipped = buildManualPayload(draft({ direction: "in", person: "Alex" }), "edit");
    expect(flipped).toMatchObject({ payload: { sender: "Alex", recipient: null } });
  });
});

describe("starting an edit from an existing transaction", () => {
  const tx = (over: Partial<Transaction>): Transaction =>
    ({
      id: 1,
      accountId: 3,
      date: "2026-09-10",
      merchant: "Corner Cafe",
      name: "Corner Cafe",
      amountMinor: 1250,
      pending: false,
      category: null,
      recipient: "Owner",
      sender: null,
      notes: null,
      isTransfer: false,
      ...over,
    }) as Transaction;

  it("reads money out with its recipient", () => {
    expect(draftFromTransaction(tx({}))).toMatchObject({
      accountId: "3",
      direction: "out",
      amount: "12.50",
      person: "Owner",
      description: "",
    });
  });

  it("reads money in with its sender, and a differing description", () => {
    expect(
      draftFromTransaction(
        tx({ amountMinor: -8000, sender: "Alex", recipient: null, name: "Dinner share" }),
      ),
    ).toMatchObject({
      direction: "in",
      amount: "80.00",
      person: "Alex",
      description: "Dinner share",
    });
  });

  it("round-trips: what is loaded can be saved unchanged", () => {
    const loaded = draftFromTransaction(
      tx({ amountMinor: -8000, sender: "Alex", recipient: null }),
    );
    expect(buildManualPayload(loaded, "edit")).toMatchObject({
      ok: true,
      payload: { amountMinor: 8000, direction: "in", sender: "Alex" },
    });
  });
});

describe("repeating a new transaction", () => {
  it("sends the repeat choice for a new transaction, and nothing when it does not repeat", () => {
    const none = buildManualPayload(draft(), "create");
    expect(none.ok && "repeat" in none.payload).toBe(false);
    const biweekly = buildManualPayload(draft({ repeat: "biweekly" }), "create");
    expect(biweekly.ok && biweekly.payload["repeat"]).toBe("biweekly");
  });

  it("never sends it when editing an existing transaction", () => {
    const edit = buildManualPayload(draft({ repeat: "weekly" }), "edit");
    expect(edit.ok && "repeat" in edit.payload).toBe(false);
  });
});
