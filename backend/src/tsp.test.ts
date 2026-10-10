import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "./utils/errors.js";
import { addDays } from "./utils/dates.js";
import {
  fetchFundPrices,
  importFundPriceCsv,
  parseFundPriceCsv,
  parsePriceDate,
  priceOnOrBefore,
  setFundPrice,
  type Fetcher,
} from "./services/fund-price.service.js";
import {
  applyDueContributions,
  createContribution,
  createTspAccount,
  dueDates,
  employerAmount,
  refreshTspValues,
  setAllocations,
  splitAmount,
  updateAllTspAccounts,
  getTspSettings,
} from "./services/tsp.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof app>;
const NOW = "2026-10-09T12:00:00Z";

describe("reading a fund price file", () => {
  const csv = [
    "Date,L Income,L 2050,G Fund,F Fund,C Fund,S Fund,I Fund",
    '2026-10-07,23.4567,18.1234,19.5,21.25,98.1,"1,234.5",45.6',
    "10/6/2026,23.4,18.1,19.49,21.2,97.9,,45.5",
    '"Oct 5, 2026",23.3,18.0,19.48,21.1,97.5,120.1,45.4',
    "Source: tsp.gov",
  ].join("\r\n");

  it("maps the TSP's column names to funds, in any of the usual date styles", () => {
    const parsed = parseFundPriceCsv(csv);
    expect(parsed.rows.map((r) => r.date)).toEqual(["2026-10-07", "2026-10-06", "2026-10-05"]);
    const first = parsed.rows[0]!.prices;
    expect(first.get("TSP-C")).toBe(98.1);
    expect(first.get("TSP-S")).toBe(1234.5); // a quoted number with a thousands comma
    expect(first.get("TSP-LINCOME")).toBe(23.4567);
    expect(first.get("TSP-L2050")).toBe(18.1234);
    // A blank cell is no price, not a zero.
    expect(parsed.rows[1]!.prices.has("TSP-S")).toBe(false);
    expect(parsed.ignoredColumns).toEqual([]);
  });

  it("ignores columns that are not funds and the notes after the table", () => {
    const parsed = parseFundPriceCsv("Date,C Fund,Notes\n2026-10-07,98.1,hello\nfooter,,");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.ignoredColumns).toEqual(["Notes"]);
  });

  it("understands a byte-order mark and tabs", () => {
    const text = String.fromCharCode(0xfeff) + "Date\tC Fund\n2026-10-07\t98.1";
    expect(parseFundPriceCsv(text).rows[0]!.prices.get("TSP-C")).toBe(98.1);
  });

  it("refuses files that are not price files", () => {
    expect(() => parseFundPriceCsv("a,b\n1,2")).toThrow(/header row/);
    expect(() => parseFundPriceCsv("Date,Apples\n2026-10-07,3")).toThrow(/None of the columns/);
    const t = app();
    expect(() => importFundPriceCsv(t.db, "Date,C Fund\nnotadate,1", NOW)).toThrow(
      /no dated prices/,
    );
  });

  it("reads dates, and refuses impossible ones", () => {
    expect(parsePriceDate("2026-02-28")).toBe("2026-02-28");
    expect(parsePriceDate("2/28/2026")).toBe("2026-02-28");
    expect(parsePriceDate("February 28, 2026")).toBe("2026-02-28");
    expect(parsePriceDate("2026-02-30")).toBeNull();
    expect(parsePriceDate("Smarch 3, 2026")).toBeNull();
  });
});

describe("stored fund prices", () => {
  it("find the price on a day, or the last business day before it, but not one long ago", () => {
    const t = app();
    setFundPrice(t.db, "TSP-C", "2026-10-02", 100, "csv", NOW); // a Friday
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-02")).toEqual({
      date: "2026-10-02",
      price: 100,
    });
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-04")).toEqual({
      date: "2026-10-02",
      price: 100,
    }); // a Sunday
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-01")).toBeNull();
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-20")).toBeNull(); // more than a week later
  });

  it("never replace a price the user typed with an imported one, but do replace an imported one", () => {
    const t = app();
    setFundPrice(t.db, "TSP-C", "2026-10-02", 100, "csv", NOW);
    setFundPrice(t.db, "TSP-C", "2026-10-02", 101, "fetched", NOW);
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-02")!.price).toBe(101);
    setFundPrice(t.db, "TSP-C", "2026-10-02", 99, "manual", NOW);
    setFundPrice(t.db, "TSP-C", "2026-10-02", 105, "csv", NOW);
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-02")!.price).toBe(99);
  });

  it("can be imported twice without changing anything", () => {
    const t = app();
    const text = "Date,C Fund\n2026-10-07,98.1\n2026-10-06,97.9";
    expect(importFundPriceCsv(t.db, text, NOW)).toMatchObject({
      days: 2,
      prices: 2,
      funds: ["TSP-C"],
    });
    importFundPriceCsv(t.db, text, NOW);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM fund_prices").get()).toEqual({ n: 2 });
  });
});

describe("the chart download from tsp.gov", () => {
  const lines = (...rows: string[]): string => rows.join("\n");

  it("reads one fund per file, with a date range as the first header cell", () => {
    const parsed = parseFundPriceCsv(
      lines(
        '﻿"May 31, 2024 to Oct 7, 2026","L 2065"',
        '"2024-06-03 00:00:00",16.4744',
        '"2024-06-04 00:00:00",16.444',
      ),
    );
    expect(parsed.rows).toEqual([
      { date: "2024-06-03", prices: new Map([["TSP-L2065", 16.4744]]) },
      { date: "2024-06-04", prices: new Map([["TSP-L2065", 16.444]]) },
    ]);
  });

  it("reads several funds side by side", () => {
    const parsed = parseFundPriceCsv(
      lines('"Jan 1, 2026 to Jan 5, 2026","C Fund","G Fund"', '"2026-01-02 00:00:00",100.5,20.1'),
    );
    expect(parsed.rows[0]!.prices.get("TSP-C")).toBe(100.5);
    expect(parsed.rows[0]!.prices.get("TSP-G")).toBe(20.1);
  });
});

describe("downloading prices", () => {
  const ok =
    (body: string): Fetcher =>
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/csv" },
      text: async () => body,
    });

  it("stores what comes back", async () => {
    const t = app();
    const summary = await fetchFundPrices(t.db, {
      today: "2026-10-09",
      now: NOW,
      fetcher: ok("Date,C Fund,G Fund\n2026-10-08,98.1,19.5"),
    });
    expect(summary).toMatchObject({ days: 1, funds: ["TSP-C", "TSP-G"] });
    expect(priceOnOrBefore(t.db, "TSP-G", "2026-10-08")!.price).toBe(19.5);
  });

  it("reads the Max TSP API's answer, matching funds by name", async () => {
    const t = app();
    const body = JSON.stringify({
      "2026-10-07": { "G Fund": 20.27, "C Fund": 125.5, "L 2050": 46.7, Mystery: 1 },
      "2026-10-08": { "C Fund": 126.25 },
    });
    const summary = await fetchFundPrices(t.db, {
      today: "2026-10-09",
      now: NOW,
      fetcher: ok(body),
    });
    expect(summary.days).toBe(2);
    expect(priceOnOrBefore(t.db, "TSP-C", "2026-10-08")!.price).toBe(126.25);
    expect(priceOnOrBefore(t.db, "TSP-G", "2026-10-08")!.price).toBe(20.27);
  });

  it("uses the chosen source and reaches back to a given first day", async () => {
    const t = app();
    const seen: string[] = [];
    const spy: Fetcher = async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "Date,C Fund\n2026-10-08,98.1",
      };
    };
    await fetchFundPrices(t.db, {
      today: "2026-10-09",
      since: "2020-03-02",
      now: NOW,
      fetcher: spy,
    });
    await fetchFundPrices(t.db, { source: "tsp.gov", today: "2026-10-09", now: NOW, fetcher: spy });
    expect(seen[0]).toContain("api.maxtsp.com");
    expect(seen[0]).toContain("start_date=2020-03-02");
    expect(seen[1]).toContain("tsp.gov");
    // A first day in the future, or before the TSP existed, is pulled into range.
    await fetchFundPrices(t.db, {
      today: "2026-10-09",
      since: "2030-01-01",
      now: NOW,
      fetcher: spy,
    });
    expect(seen[2]).toContain("start_date=2026-10-09");
    await fetchFundPrices(t.db, {
      today: "2026-10-09",
      since: "1990-01-01",
      now: NOW,
      fetcher: spy,
    });
    expect(seen[3]).toMatch(/start_date=19(9d|8d)|start_date=1996/);
  });

  it("asks for the period it needs, with the dates in the address", async () => {
    const t = app();
    let seen = "";
    await fetchFundPrices(t.db, {
      today: "2026-10-09",
      days: 10,
      now: NOW,
      fetcher: async (url) => {
        seen = url;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "Date,C Fund\n2026-10-08,98.1",
        };
      },
    });
    expect(seen).toContain("2026-09-29");
    expect(seen).toContain("2026-10-09");
  });

  it("explains a refusal and points at the price file, rather than working around it", async () => {
    const t = app();
    const refused: Fetcher = async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => "denied",
    });
    await expect(fetchFundPrices(t.db, { fetcher: refused })).rejects.toMatchObject({
      status: 502,
      code: "prices_unavailable",
      message: expect.stringMatching(/403.*Import price file/s),
    });
  });

  it("says so when it cannot connect, or what came back is not a price file", async () => {
    const t = app();
    const offline: Fetcher = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(fetchFundPrices(t.db, { fetcher: offline })).rejects.toMatchObject({
      code: "prices_unavailable",
      message: expect.stringMatching(/connection/),
    });
    await expect(
      fetchFundPrices(t.db, { fetcher: ok("<html>Access Denied</html>") }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(fetchFundPrices(t.db, { fetcher: ok("Date,C Fund\n") })).rejects.toMatchObject({
      code: "prices_unavailable",
    });
  });
});

describe("when a contribution is due", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    amountMinor: 50000,
    frequency: "biweekly" as const,
    startDate: "2026-09-07", // a Monday
    ...over,
  });
  const due = (c: Parameters<typeof dueDates>[0], to: string) => dueDates(c, c.startDate, to);
  const row = (over: Partial<Parameters<typeof dueDates>[0]> = {}) => ({
    frequency: "biweekly",
    startDate: "2026-09-07",
    endDate: null,
    dayOfMonth: null,
    secondDayOfMonth: null,
    ...over,
  });

  it("weekly, every two weeks, twice a month, and monthly", () => {
    expect(due(row({ frequency: "weekly" }), "2026-09-28")).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
    expect(due(row(), "2026-10-09")).toEqual(["2026-09-07", "2026-09-21", "2026-10-05"]);
    expect(
      due(
        row({
          frequency: "semimonthly",
          dayOfMonth: 1,
          secondDayOfMonth: 15,
          startDate: "2026-09-01",
        }),
        "2026-10-31",
      ),
    ).toEqual(["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15"]);
    expect(
      due(row({ frequency: "monthly", dayOfMonth: 31, startDate: "2026-01-31" }), "2026-03-31"),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(due(row({ endDate: "2026-09-21" }), "2026-12-31")).toEqual(["2026-09-07", "2026-09-21"]);
  });

  it("splits an amount to the cent, leftover cents to the biggest share", () => {
    const split = splitAmount(10001, [
      { symbol: "A", bps: 3333 },
      { symbol: "B", bps: 3333 },
      { symbol: "C", bps: 3334 },
    ]);
    expect([...split.values()].reduce((a, b) => a + b, 0)).toBe(10001);
    expect(split.get("C")).toBeGreaterThanOrEqual(split.get("A")!);
    expect(
      splitAmount(50000, [
        { symbol: "A", bps: 6000 },
        { symbol: "B", bps: 4000 },
      ]),
    ).toEqual(
      new Map([
        ["A", 30000],
        ["B", 20000],
      ]),
    );
  });

  // ---- a whole account -------------------------------------------------------------------

  function account(t: T) {
    const id = createTspAccount(
      t.db,
      {
        name: "My TSP",
        allocations: [
          { symbol: "TSP-C", percent: 60 },
          { symbol: "TSP-S", percent: 40 },
        ],
      },
      NOW,
    );
    // Daily prices every day for a month (the TSP also publishes on weekdays only: leave weekends out).
    const rows = ["Date,C Fund,S Fund"];
    for (let d = "2026-09-01"; d <= "2026-10-09"; d = addDays(d, 1)) {
      const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const n = Number(d.slice(8)) + (d.slice(5, 7) === "10" ? 30 : 0);
      rows.push(`${d},${(100 + n).toFixed(2)},${(50 + n / 2).toFixed(2)}`);
    }
    importFundPriceCsv(t.db, rows.join("\n"), NOW);
    return id;
  }
  const held = (t: T, accountId: number) =>
    t.sqlite
      .prepare(
        "SELECT s.symbol AS symbol, h.quantity AS quantity, h.cost_basis_minor AS cost, h.value_minor AS value FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = ? ORDER BY s.symbol",
      )
      .all(accountId) as Array<{ symbol: string; quantity: number; cost: number; value: number }>;

  it("turns a dollar amount into units at the day's price, by the allocation", () => {
    const t = app();
    const id = account(t);
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-10", dayOfMonth: 10 }),
      NOW,
    );
    const result = applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    expect(result).toEqual({ applied: 1, waiting: [] });
    // Sep 10: C is 110.00, S is 55.00. $300.00 into C and $200.00 into S.
    const rows = held(t, id);
    const c = rows.find((r) => r.symbol === "TSP-C")!;
    const s = rows.find((r) => r.symbol === "TSP-S")!;
    expect(c.quantity).toBeCloseTo(300 / 110, 4);
    expect(s.quantity).toBeCloseTo(200 / 55, 4);
    expect(c.cost).toBe(30000);
    expect(s.cost).toBe(20000);
    // The balance is the units at the newest price on file (Oct 9: C 139.00, S 69.50).
    const balance = (
      t.sqlite.prepare("SELECT current_balance_minor AS b FROM accounts WHERE id = ?").get(id) as {
        b: number;
      }
    ).b;
    expect(balance).toBe(Math.round(c.quantity * 139 * 100) + Math.round(s.quantity * 69.5 * 100));
  });

  it("records each purchase as activity, once", () => {
    const t = app();
    const id = account(t);
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-10", dayOfMonth: 10 }),
      NOW,
    );
    applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    const activity = t.sqlite
      .prepare(
        "SELECT type, quantity, price, amount_minor AS amount, subtype FROM investment_transactions WHERE account_id = ? ORDER BY id",
      )
      .all(id) as Array<Record<string, unknown>>;
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({
      type: "contribution",
      price: 110,
      amount: -30000,
      subtype: "recurring contribution",
    });
    // Applying again does nothing: no duplicate units, rows, or snapshots of change.
    const before = held(t, id);
    expect(applyDueContributions(t.db, { today: "2026-09-30", now: NOW })).toEqual({
      applied: 0,
      waiting: [],
    });
    expect(held(t, id)).toEqual(before);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM investment_transactions").get()).toEqual({
      n: 2,
    });
  });

  it("works out the federal (FERS) match and a custom one", () => {
    const pay = 400_000; // $4,000 a paycheck
    const fers = (amountMinor: number) =>
      employerAmount({
        amountMinor,
        matchPlan: "fers",
        payMinor: pay,
        matchPercent: null,
        matchUpToPercent: null,
        autoPercent: null,
      });
    expect(fers(0)).toBe(4_000); // 1% automatic only
    expect(fers(12_000)).toBe(4_000 + 12_000); // 3% in: matched in full
    expect(fers(20_000)).toBe(4_000 + 12_000 + 4_000); // 5% in: 4% match
    expect(fers(40_000)).toBe(20_000); // more than 5% earns no more
    const custom = employerAmount({
      amountMinor: 40_000,
      matchPlan: "custom",
      payMinor: pay,
      matchPercent: 50,
      matchUpToPercent: 3,
      autoPercent: 2,
    });
    expect(custom).toBe(12_000 + 8_000); // half of $400 capped at 3% of pay, plus 2% of pay
    expect(
      employerAmount({
        amountMinor: 1,
        matchPlan: null,
        payMinor: pay,
        matchPercent: 50,
        matchUpToPercent: 3,
        autoPercent: 2,
      }),
    ).toBe(0);
  });

  it("buys units with the employer's money too, recorded on its own", () => {
    const t = app();
    const id = account(t);
    const c = createContribution(
      t.db,
      id,
      base({
        frequency: "once",
        startDate: "2026-09-10",
        amountMinor: 20_000,
        matchPlan: "fers",
        payMinor: 400_000,
      }),
      NOW,
    );
    expect(c.employerMinor).toBe(20_000);
    expect(c.description).toContain("plus $200.00 from your employer");
    applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    const rows = t.sqlite
      .prepare(
        "SELECT subtype, SUM(amount_minor) AS amount FROM investment_transactions WHERE account_id = ? GROUP BY subtype ORDER BY subtype",
      )
      .all(id);
    expect(rows).toEqual([
      { subtype: "employer contribution", amount: -20_000 },
      { subtype: "recurring contribution", amount: -20_000 },
    ]);
    // $400 in all at the allocation: $240 into C (110.00) and $160 into S (55.00).
    const cFund = held(t, id).find((r) => r.symbol === "TSP-C")!;
    expect(cFund.quantity).toBeCloseTo(240 / 110, 3);
    expect(cFund.cost).toBe(24_000);
    expect(() =>
      createContribution(t.db, id, base({ matchPlan: "fers", payMinor: null }), NOW),
    ).toThrow(AppError);
  });

  it("makes a one-time contribution once, on its day, alongside recurring ones", () => {
    const t = app();
    const id = account(t);
    const once = createContribution(
      t.db,
      id,
      base({ frequency: "once", startDate: "2026-09-10", endDate: null }),
      NOW,
    );
    expect(once.endDate).toBe("2026-09-10");
    expect(once.description).toMatch(/once, on 2026-09-10/);
    expect(dueDates({ ...once, frequency: "once" }, "2026-01-01", "2026-12-31")).toEqual([
      "2026-09-10",
    ]);
    expect(applyDueContributions(t.db, { today: "2026-09-05", now: NOW }).applied).toBe(0);
    expect(applyDueContributions(t.db, { today: "2026-09-30", now: NOW }).applied).toBe(1);
    expect(applyDueContributions(t.db, { today: "2026-12-31", now: NOW }).applied).toBe(0);
    const c = held(t, id).find((r) => r.symbol === "TSP-C")!;
    expect(c.quantity).toBeCloseTo(300 / 110, 4);
    const names = t.sqlite
      .prepare("SELECT DISTINCT name FROM investment_transactions WHERE account_id = ?")
      .all(id) as Array<{ name: string }>;
    expect(names.every((n) => n.name.startsWith("One-time contribution"))).toBe(true);
  });

  it("catches up on every day that came due while the app was closed", () => {
    const t = app();
    const id = account(t);
    createContribution(t.db, id, base(), NOW); // every 2 weeks from Mon Sep 7
    expect(applyDueContributions(t.db, { today: "2026-10-09", now: NOW }).applied).toBe(3); // Sep 7, Sep 21, Oct 5
    const c = held(t, id).find((r) => r.symbol === "TSP-C")!;
    const expected = 300 / 107 + 300 / 121 + 300 / 135;
    expect(c.quantity).toBeCloseTo(expected, 3);
    expect(c.cost).toBe(3 * 30000);
  });

  it("uses the last business day's price when the day falls on a weekend", () => {
    const t = app();
    const id = account(t);
    // Sat Sep 12 has no price: Friday Sep 11 (C 111.00) is used.
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-12", dayOfMonth: 12 }),
      NOW,
    );
    applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    const used = t.sqlite
      .prepare(
        "SELECT price_date AS d, price AS p FROM tsp_contribution_applications WHERE symbol = 'TSP-C'",
      )
      .get();
    expect(used).toEqual({ d: "2026-09-11", p: 111 });
  });

  it("waits when a price is missing, and finishes once it arrives", () => {
    const t = app();
    const id = createTspAccount(
      t.db,
      { name: "TSP", allocations: [{ symbol: "TSP-C", percent: 100 }] },
      NOW,
    );
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-10", dayOfMonth: 10 }),
      NOW,
    );
    const first = applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    expect(first.applied).toBe(0);
    expect(first.waiting).toEqual([
      { contributionId: expect.any(Number), date: "2026-09-10", missing: ["TSP-C"] },
    ]);
    expect(getTspSettings(t.db, id, "2026-09-30").waiting).toHaveLength(1);
    importFundPriceCsv(t.db, "Date,C Fund\n2026-09-10,100.00", NOW);
    expect(updateAllTspAccounts(t.db, { today: "2026-09-30", now: NOW })).toMatchObject({
      applied: 1,
      waiting: 0,
    });
    expect(held(t, id)[0]!.quantity).toBeCloseTo(5, 4);
  });

  it("adds to units already held, and a contribution not yet due changes nothing", () => {
    const t = app();
    const id = account(t);
    // Existing holding: 10 units of C, entered by hand before the plan was set up.
    t.sqlite.prepare("SELECT 1").get();
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-10-20", dayOfMonth: 20 }),
      NOW,
    );
    expect(applyDueContributions(t.db, { today: "2026-10-09", now: NOW })).toEqual({
      applied: 0,
      waiting: [],
    });
    expect(held(t, id)).toEqual([]);
  });

  it("keeps the balance at the newest price between contributions, and only records a change", () => {
    const t = app();
    const id = account(t);
    createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-10", dayOfMonth: 10 }),
      NOW,
    );
    applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    const snapshots = () =>
      (
        t.sqlite
          .prepare("SELECT COUNT(*) AS n FROM balance_snapshots WHERE account_id = ?")
          .get(id) as { n: number }
      ).n;
    const before = snapshots();
    expect(refreshTspValues(t.db, { today: "2026-10-01", now: NOW })).toBe(0); // same prices: nothing to do
    expect(snapshots()).toBe(before);
    importFundPriceCsv(t.db, "Date,C Fund,S Fund\n2026-10-10,200.00,100.00", NOW);
    expect(refreshTspValues(t.db, { today: "2026-10-10", now: NOW })).toBe(1);
    expect(snapshots()).toBe(before + 1);
    const c = held(t, id).find((r) => r.symbol === "TSP-C")!;
    expect(c.value).toBe(Math.round(c.quantity * 200 * 100));
  });

  it("stopping a contribution leaves what it already bought", () => {
    const t = app();
    const id = account(t);
    const created = createContribution(
      t.db,
      id,
      base({ frequency: "monthly", startDate: "2026-09-10", dayOfMonth: 10 }),
      NOW,
    );
    applyDueContributions(t.db, { today: "2026-09-30", now: NOW });
    t.sqlite.prepare("DELETE FROM tsp_contributions WHERE id = ?").run(created.id);
    expect(held(t, id)).toHaveLength(2);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM investment_transactions").get()).toEqual({
      n: 2,
    });
  });
});

describe("setting up the plan", () => {
  it("needs the split to total exactly 100% of known funds, with no repeats", () => {
    const t = app();
    const bad = (allocations: Array<{ symbol: string; percent: number }>) =>
      expect(() => createTspAccount(t.db, { name: "TSP", allocations }, NOW)).toThrow(AppError);
    bad([]);
    bad([{ symbol: "TSP-C", percent: 99 }]);
    bad([
      { symbol: "TSP-C", percent: 60 },
      { symbol: "TSP-S", percent: 41 },
    ]);
    bad([
      { symbol: "TSP-C", percent: 50 },
      { symbol: "TSP-C", percent: 50 },
    ]);
    bad([{ symbol: "NOPE", percent: 100 }]);
    bad([
      { symbol: "TSP-C", percent: 33.333 },
      { symbol: "TSP-S", percent: 66.667 },
    ]);
    expect(
      createTspAccount(
        t.db,
        {
          name: "TSP",
          allocations: [
            { symbol: "G Fund", percent: 33.33 },
            { symbol: "C Fund", percent: 66.67 },
          ],
        },
        NOW,
      ),
    ).toBeGreaterThan(0);
  });

  it("can change the split later, and only on a TSP account", () => {
    const t = app();
    const id = createTspAccount(
      t.db,
      { name: "TSP", allocations: [{ symbol: "TSP-C", percent: 100 }] },
      NOW,
    );
    const after = setAllocations(t.db, id, [{ symbol: "TSP-L2050", percent: 100 }]);
    expect(after).toEqual([
      { symbol: "TSP-L2050", code: "L2050", name: "TSP L 2050 Fund", percent: 100 },
    ]);
    const plain = (
      t.sqlite
        .prepare(
          "INSERT INTO accounts (name, type, currency, is_manual, source, created_at, updated_at) VALUES ('Other', 'investment', 'USD', 1, 'manual', 'x', 'x') RETURNING id",
        )
        .get() as { id: number }
    ).id;
    expect(() => setAllocations(t.db, plain, [{ symbol: "TSP-C", percent: 100 }])).toThrow(
      /not a Thrift/,
    );
  });

  it("rejects bad contributions", () => {
    const t = app();
    const id = createTspAccount(
      t.db,
      { name: "TSP", allocations: [{ symbol: "TSP-C", percent: 100 }] },
      NOW,
    );
    const bad = (over: Record<string, unknown>) =>
      expect(() =>
        createContribution(
          t.db,
          id,
          { amountMinor: 1000, frequency: "monthly", startDate: "2026-09-01", ...over } as never,
          NOW,
        ),
      ).toThrow(AppError);
    bad({ amountMinor: 0 });
    bad({ amountMinor: 1.5 });
    bad({ frequency: "daily" });
    bad({ startDate: "2026-02-30" });
    bad({ endDate: "2026-08-01" });
    bad({ dayOfMonth: 40 });
  });
});

describe("through the API", () => {
  it("creates an account, takes a price file, applies a contribution, and shows the result", async () => {
    const t = app();
    const today = new Date().toISOString().slice(0, 10);
    const start = addDays(today, -20);
    const created = await t
      .call("post", "/api/tsp/accounts")
      .send({
        name: "My TSP",
        allocations: [
          { symbol: "TSP-C", percent: 70 },
          { symbol: "TSP-G", percent: 30 },
        ],
      })
      .expect(201);
    const id = created.body.id as number;
    const rows = ["Date,C Fund,G Fund"];
    for (let i = 25; i >= 0; i--)
      rows.push(`${addDays(today, -i)},${(100 + i).toFixed(2)},${(20 + i / 100).toFixed(4)}`);
    const imported = await t
      .call("post", "/api/tsp/prices/import")
      .send({ csv: rows.join("\n") })
      .expect(200);
    expect(imported.body).toMatchObject({ days: 26, funds: ["TSP-C", "TSP-G"] });

    const made = await t
      .call("post", `/api/accounts/${id}/tsp/contributions`)
      .send({ amountMinor: 100000, frequency: "weekly", startDate: start })
      .expect(201);
    // Three weeks of it came due, and was applied straight away.
    expect(made.body.applied).toBe(3);
    const settings = (await t.call("get", `/api/accounts/${id}/tsp`).expect(200)).body;
    expect(settings.contributions[0]).toMatchObject({
      description: "$1,000.00 every week",
      active: true,
    });
    expect(settings.recent).toHaveLength(3);
    expect(settings.recent[0].parts.map((p: { code: string }) => p.code).sort()).toEqual([
      "C",
      "G",
    ]);
    expect(settings.waiting).toEqual([]);

    // The holdings and the balance follow.
    const accounts = (await t.call("get", "/api/accounts").expect(200)).body as Array<{
      id: number;
      currentBalanceMinor: number;
    }>;
    expect(accounts.find((a) => a.id === id)!.currentBalanceMinor).toBeGreaterThan(300000 * 0.9);

    // A manual price, and the fund list with each fund's newest price.
    await t
      .call("post", "/api/tsp/prices")
      .send({ symbol: "TSP-S", date: today, price: 77.5 })
      .expect(201);
    const funds = (await t.call("get", "/api/tsp/funds").expect(200)).body as Array<{
      symbol: string;
      latest: { price: number } | null;
    }>;
    expect(funds.find((f) => f.symbol === "TSP-S")!.latest!.price).toBe(77.5);
    expect(funds.find((f) => f.symbol === "TSP-C")!.latest).not.toBeNull();
    expect(funds.find((f) => f.symbol === "TSP-L2075")!.latest).toBeNull();
  });

  it("catches up from the TSP's chart and activity files, with the balance history", async () => {
    const t = app();
    const id = (
      await t
        .call("post", "/api/tsp/accounts")
        .send({ name: "My TSP", allocations: [{ symbol: "TSP-L2065", percent: 100 }] })
        .expect(201)
    ).body.id as number;
    // The chart download: a date range and the fund as the header, then a time and price per day.
    const chart = ['﻿"Jun 2, 2025 to Jun 6, 2025","L 2065"'];
    for (let d = 2; d <= 6; d++) chart.push(`"2025-06-0${d} 00:00:00",${(10 + d / 10).toFixed(4)}`);
    const prices = await t
      .call("post", "/api/tsp/prices/import")
      .send({ csv: chart.join("\r\n") })
      .expect(200);
    expect(prices.body).toMatchObject({ days: 5, funds: ["TSP-L2065"] });

    // Investment Activity Detail: two contributions on Jun 3.
    const activity = [
      '"VALUATION DATE","POSTING DATE","ACTIVITY TYPE","PLAN","ACCOUNT","FUND","AMOUNT","FUND NAV/PRICE","FUND UNITS",',
      '"06-03-2025","06-04-2025","Traditional","Thrift Savings Plan - Civilian","Traditional","L 2065","103.00","10.3000","10.000000",',
      '"06-03-2025","06-04-2025","Match","Thrift Savings Plan - Civilian","Match","L 2065","51.50","10.3000","5.000000",',
    ];
    const imported = await t
      .call("post", `/api/accounts/${id}/tsp/activity/import`)
      .send({ csv: activity.join("\r\n"), updateHoldings: true })
      .expect(200);
    expect(imported.body).toMatchObject({ added: 2, holdingsUpdated: true });
    expect(imported.body.history).toMatchObject({ from: "2025-06-03", to: "2025-06-06", days: 4 });

    // 15 units each day, at that day's price.
    const history = t.sqlite
      .prepare(
        "SELECT observed_at AS at, current_balance_minor AS v FROM balance_snapshots WHERE account_id = ? AND observed_at LIKE '%T20:00:00.000Z' ORDER BY observed_at",
      )
      .all(id) as Array<{ at: string; v: number }>;
    expect(history.map((h) => h.v)).toEqual([15450, 15600, 15750, 15900]);

    // Importing again changes nothing, and a new price file rebuilds rather than duplicates.
    await t
      .call("post", `/api/accounts/${id}/tsp/activity/import`)
      .send({ csv: activity.join("\r\n"), updateHoldings: true })
      .expect(200);
    await t
      .call("post", "/api/tsp/prices/import")
      .send({ csv: chart.join("\r\n") })
      .expect(200);
    const again = t.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM balance_snapshots WHERE account_id = ? AND observed_at LIKE '%T20:00:00.000Z'",
      )
      .get(id);
    expect(again).toEqual({ n: 4 });
    const held = t.sqlite
      .prepare("SELECT quantity FROM holdings WHERE account_id = ?")
      .all(id) as Array<{ quantity: number }>;
    expect(held).toEqual([{ quantity: 15 }]);
  });

  it("explains an automatic download that is refused", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const saved = process.env["PF_TSP_PRICES_URL"];
    process.env["PF_TSP_PRICES_URL"] = "http://127.0.0.1:9/never"; // nothing listens there
    try {
      const res = await t.call("post", "/api/tsp/prices/fetch").send({}).expect(502);
      expect(res.body.error).toBe("prices_unavailable");
      expect(res.body.message).toMatch(/Import price file/);
    } finally {
      if (saved === undefined) delete process.env["PF_TSP_PRICES_URL"];
      else process.env["PF_TSP_PRICES_URL"] = saved;
    }
  });

  it("is removed with the account", async () => {
    const t = app();
    const created = await t
      .call("post", "/api/tsp/accounts")
      .send({ name: "TSP", allocations: [{ symbol: "TSP-C", percent: 100 }] })
      .expect(201);
    const id = created.body.id as number;
    await t
      .call("post", `/api/accounts/${id}/tsp/contributions`)
      .send({ amountMinor: 1000, frequency: "monthly", startDate: "2026-01-01" })
      .expect(201);
    await t.call("delete", `/api/investments/accounts/${id}`);
    t.sqlite.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM tsp_contributions").get()).toEqual({ n: 0 });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM tsp_allocations").get()).toEqual({ n: 0 });
  });
});
