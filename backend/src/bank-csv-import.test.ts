import { afterEach, describe, expect, it } from "vitest";
import { parseBankCsv, readBankDate } from "./services/bank-csv-import.service.js";
import { makeSyncHarness } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const WELLS_FARGO = [
  '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"',
  '"09/17/2026","ZELLE TO SAM ON 09/16 REF # ABC123","-50.00","","Posted"',
  '"09/15/2026","PAYROLL DEPOSIT","1,250.00","","Posted"',
  '"09/14/2026","COFFEE SHOP","-4.25","","Pending"',
  '"09/10/2026","","-120.00","1042","Posted"',
].join("\r\n");

describe("reading a bank's CSV export", () => {
  it("reads dates the way banks write them", () => {
    expect(readBankDate("09/17/2026")).toBe("2026-09-17");
    expect(readBankDate("9/7/26")).toBe("2026-09-07");
    expect(readBankDate("2026-09-17")).toBe("2026-09-17");
    expect(readBankDate("02/30/2026")).toBeNull();
  });

  it("reads Wells Fargo's export: signed amounts, pending rows, and checks", () => {
    const { rows } = parseBankCsv(WELLS_FARGO);
    expect(rows).toEqual([
      {
        line: 2,
        date: "2026-09-17",
        description: "ZELLE TO SAM ON 09/16 REF # ABC123",
        amountMinor: -5000,
        pending: false,
      },
      {
        line: 3,
        date: "2026-09-15",
        description: "PAYROLL DEPOSIT",
        amountMinor: 125000,
        pending: false,
      },
      { line: 4, date: "2026-09-14", description: "COFFEE SHOP", amountMinor: -425, pending: true },
      {
        line: 5,
        date: "2026-09-10",
        description: "Check #1042",
        amountMinor: -12000,
        pending: false,
      },
    ]);
  });

  it("reads Wells Fargo's older export, which has no header row", () => {
    const { rows, format } = parseBankCsv(
      '"09/17/2026","-50.00","*","","ZELLE TO SAM"\n"09/15/2026","20.00","*","","REFUND"',
    );
    expect(format).toMatch(/Wells Fargo/);
    expect(rows.map((r) => [r.date, r.amountMinor, r.description])).toEqual([
      ["2026-09-17", -5000, "ZELLE TO SAM"],
      ["2026-09-15", 2000, "REFUND"],
    ]);
  });

  it("reads separate debit and credit columns, and flips files that show charges as positive", () => {
    const debitCredit =
      "Posted Date,Payee,Debit,Credit\n2026-09-01,GROCERY,12.50,\n2026-09-02,REFUND,,3.00";
    expect(parseBankCsv(debitCredit).rows.map((r) => r.amountMinor)).toEqual([-1250, 300]);
    const card = "Transaction Date,Description,Amount\n09/01/2026,GROCERY,12.50";
    expect(parseBankCsv(card, true).rows[0]!.amountMinor).toBe(-1250);
  });

  it("names every bad line and imports nothing", () => {
    expect(() =>
      parseBankCsv("Date,Description,Amount\nyesterday,X,1.00\n09/01/2026,Y,abc"),
    ).toThrow(/line 2.*line 3/);
    expect(() => parseBankCsv("Date,Description\n09/01/2026,X")).toThrow(/amount column/);
  });
});

async function setup(kind = "checking", openingBalanceMinor?: number) {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const id = (
    await h
      .call("post", "/api/accounts/manual")
      .send({
        name: "Wells Fargo Checking",
        kind,
        ...(openingBalanceMinor === undefined ? {} : { openingBalanceMinor }),
      })
      .expect(201)
  ).body.id as number;
  const importCsv = (body: Record<string, unknown>, status = 200) =>
    h
      .call("post", `/api/accounts/manual/${id}/import-csv`)
      .send({ csv: WELLS_FARGO, ...body })
      .expect(status);
  const list = async () =>
    (await h.call("get", `/api/transactions?accountId=${id}&pageSize=200`).expect(200)).body
      .items as Array<{
      merchant: string;
      amountMinor: number;
      pending: boolean;
      date: string;
    }>;
  const balance = async () =>
    (
      (await h.call("get", "/api/accounts").expect(200)).body as Array<{
        id: number;
        currentBalanceMinor: number;
      }>
    ).find((a) => a.id === id)!.currentBalanceMinor;
  return { h, id, importCsv, list, balance };
}

describe("importing into an account kept by hand", () => {
  it("previews without changing anything", async () => {
    const { importCsv, list } = await setup();
    const preview = (await importCsv({ dryRun: true })).body;
    expect(preview).toMatchObject({
      added: 0,
      duplicates: 0,
      balanceBeforeMinor: 0,
      balanceAfterMinor: 107575,
    });
    expect(preview.rows).toHaveLength(4);
    expect(await list()).toEqual([]);
  });

  it("adds the rows, moves the balance, and skips them when the same file comes again", async () => {
    const { importCsv, list, balance } = await setup();
    expect((await importCsv({})).body).toMatchObject({ added: 4, duplicates: 0 });
    const rows = await list();
    expect(rows.find((r) => r.merchant === "PAYROLL DEPOSIT")).toMatchObject({
      amountMinor: -125000,
    });
    expect(rows.find((r) => r.merchant === "COFFEE SHOP")).toMatchObject({ pending: true });
    expect(await balance()).toBe(107575);

    expect((await importCsv({})).body).toMatchObject({ added: 0, duplicates: 4 });
    expect(await list()).toHaveLength(4);
  });

  it("can keep today's balance, treating the file as history it already includes", async () => {
    const { importCsv, list, balance } = await setup("checking", 500_000);
    const result = (await importCsv({ keepBalance: true })).body;
    expect(result).toMatchObject({
      added: 4,
      balanceBeforeMinor: 500_000,
      balanceAfterMinor: 500_000,
    });
    expect(await balance()).toBe(500_000);
    // The opening balance now starts the day before the first imported row.
    const opening = (await list()).find((r) => r.merchant === "Opening balance")!;
    expect(opening).toMatchObject({ date: "2026-09-09", amountMinor: -(500_000 - 107_575) });
  });

  it("refuses connected and store credit accounts", async () => {
    const { h } = await setup();
    const credit = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Gift card", kind: "store_credit" })
        .expect(201)
    ).body.id as number;
    await h
      .call("post", `/api/accounts/manual/${credit}/import-csv`)
      .send({ csv: WELLS_FARGO })
      .expect(409);
  });
});
