import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "./utils/dates.js";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}

const today = new Date().toISOString().slice(0, 10);
type Reminder = { id: string; kind: string; title: string; body: string };
const reminders = async (t: ReturnType<typeof app>) =>
  (await t.call("get", "/api/reminders").expect(200)).body as Reminder[];
const turnOn = (t: ReturnType<typeof app>, which: Record<string, boolean>) =>
  t
    .call("patch", "/api/settings")
    .send({ reminders: { bills: false, signIn: false, budgets: false, ...which } })
    .expect(200);

describe("reminders for desktop notifications", () => {
  it("are all off until turned on", async () => {
    const t = app();
    const { item } = await linkDemoBank(t.call);
    await t.call("post", `/api/plaid/fake/items/${item.id}/simulate-login-required`).expect(200);
    expect(await reminders(t)).toEqual([]);
  });

  it("remind of a bank that needs a fresh sign-in, once a day", async () => {
    const t = app();
    const { item } = await linkDemoBank(t.call);
    await turnOn(t, { signIn: true });
    expect(await reminders(t)).toEqual([]);
    await t.call("post", `/api/plaid/fake/items/${item.id}/simulate-login-required`).expect(200);
    const [r] = await reminders(t);
    expect(r).toMatchObject({
      id: `sign_in:${item.id}:${today}`,
      kind: "sign_in",
      title: "First Platypus Bank needs you to sign in again",
    });
  });

  it("remind of a budget nearly and then fully used, once per level", async () => {
    const t = app();
    await turnOn(t, { budgets: true });
    const category = (await t.call("post", "/api/categories").send({ name: "Treats" }).expect(201))
      .body.id as number;
    await t
      .call("post", "/api/budgets")
      .send({ categoryId: category, month: today.slice(0, 7), amountMinor: 10_000 })
      .expect(201);
    const wallet = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash", openingBalanceMinor: 50_000 })
        .expect(201)
    ).body.id as number;
    const spend = (amountMinor: number) =>
      t
        .call("post", "/api/transactions")
        .send({
          accountId: wallet,
          date: today,
          merchant: "Bakery",
          amountMinor,
          direction: "out",
          categoryId: category,
        })
        .expect(201);

    await spend(5_000);
    expect(await reminders(t)).toEqual([]);
    await spend(4_500);
    const [near] = await reminders(t);
    expect(near).toMatchObject({ kind: "budget", title: "Treats budget is nearly used up" });
    expect(near!.id).toMatch(/:near$/);
    expect(near!.body).toContain("95%");
    await spend(1_000);
    const [over] = await reminders(t);
    expect(over!.title).toBe("Treats budget is over");
    expect(over!.id).toMatch(/:over$/);
  });

  it("remind of a payment due in the next few days, and not one further out", async () => {
    const t = app();
    await turnOn(t, { bills: true });
    const wallet = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash", openingBalanceMinor: 50_000 })
        .expect(201)
    ).body.id as number;
    // A weekly charge paid 5 days ago is next due in 2 days; one paid yesterday, in 6.
    for (const [merchant, ago] of [
      ["Gym", 5],
      ["Piano lesson", 1],
    ] as const) {
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: wallet,
          date: addDays(today, -ago),
          merchant,
          amountMinor: 2_500,
          direction: "out",
          repeat: "weekly",
        })
        .expect(201);
    }
    const due = await reminders(t);
    expect(due.map((r) => r.title)).toEqual([
      `Gym is due on ${new Date(`${addDays(today, 2)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}`,
    ]);
    expect(due[0]!.body).toBe("$25.00 payment.");
  });
});
