import { afterEach, describe, expect, it } from "vitest";
import {
  dismissRenewal,
  paymentHistory,
  renewalInbox,
  setPaymentExcluded,
} from "./services/renewal.service.js";
import {
  createTrackedSubscription,
  type TrackedSubscriptionInput,
} from "./services/tracked-subscriptions.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-10";

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const card = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "credit_card" })
      .expect(201)
  ).body.id as number;
  const add = async (date: string, merchant: string, amountMinor: number) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: card, date, merchant, amountMinor, direction: "out" })
        .expect(201)
    ).body.id as number;
  const track = (input: Partial<TrackedSubscriptionInput> & { name: string }) => {
    const list = createTrackedSubscription(
      t.db,
      {
        amountMinor: 1000,
        billing: "recurring",
        frequency: "monthly",
        startDate: "2026-01-15",
        ...input,
      },
      TODAY,
    );
    return list.subscriptions.find((s) => s.name === input.name)!.id;
  };
  return { t, add, track };
}

describe("a subscription's payments", () => {
  it("are found by name, can leave one out, and show when the price changed", async () => {
    const { t, add, track } = await setup();
    await add("2026-08-15", "Netflix", 1549);
    await add("2026-09-15", "Netflix", 1549);
    const gift = await add("2026-09-20", "Netflix gift card", 5000);
    await add("2026-10-01", "NETFLIX.COM", 1799);
    await add("2026-10-02", "Coffee", 400);
    const id = track({ name: "Netflix", amountMinor: 1799 });

    let h = paymentHistory(t.db, id, TODAY);
    expect(h).toMatchObject({ match: "Netflix", matchSource: "name" });
    expect(h.payments.map((p) => p.date)).toEqual([
      "2026-10-01",
      "2026-09-20",
      "2026-09-15",
      "2026-08-15",
    ]);

    setPaymentExcluded(t.db, id, gift, true);
    h = paymentHistory(t.db, id, TODAY);
    expect(h.payments.find((p) => p.id === gift)!.excluded).toBe(true);
    expect(h.payments[0]).toMatchObject({ amountMinor: 1799, changeMinor: 250 });
    expect(h.totalMinor).toBe(1549 + 1549 + 1799);

    const price = renewalInbox(t.db, TODAY).find((i) => i.kind === "price");
    expect(price).toMatchObject({ subscriptionId: id, changeMinor: 250, date: "2026-10-01" });
  });
});

describe("the renewal inbox", () => {
  it("lists trials ending, yearly renewals and plans ending, soonest first, until dismissed", async () => {
    const { t, track } = await setup();
    track({ name: "Domain", frequency: "yearly", startDate: "2025-10-20", amountMinor: 2000 });
    track({ name: "Music", trialEndsOn: "2026-10-15" });
    // Twelve payments from December: the last on November 5.
    track({ name: "Phone", billing: "installments", termMonths: 12, startDate: "2025-12-05" });
    // Too far off to list yet.
    track({ name: "Cloud", frequency: "yearly", startDate: "2026-03-01", amountMinor: 9900 });

    const inbox = renewalInbox(t.db, TODAY);
    expect(inbox.map((i) => [i.kind, i.title, i.date])).toEqual([
      ["trial", "Music trial ends", "2026-10-15"],
      ["renewal", "Domain renews", "2026-10-20"],
      ["ending", "Phone ends", "2026-11-05"],
    ]);

    dismissRenewal(t.db, inbox[1]!.key);
    expect(renewalInbox(t.db, TODAY).map((i) => i.kind)).toEqual(["trial", "ending"]);
    const res = await t.call("post", "/api/renewals/dismiss").send({ key: inbox[0]!.key });
    expect(res.status).toBe(200);
  });
});
