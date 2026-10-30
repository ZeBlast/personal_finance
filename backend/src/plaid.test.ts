import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlaidApi } from "plaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, credentials, plaidItems } from "../../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { FakePlaidGateway } from "./plaid/fake-gateway.js";
import { PlaidGatewayError } from "./plaid/gateway.js";
import { createGatewayProvider } from "./plaid/provider.js";
import { RealPlaidGateway, toGatewayError } from "./plaid/real-gateway.js";
import { upsertItemAccounts } from "./services/account.service.js";
import { savePlaidCredentials } from "./services/credentials.service.js";
import { createCipher, resolveEncryptionKey } from "./services/crypto.js";
import { updateSettings } from "./services/settings.service.js";
import { toMinorUnits } from "./utils/money.js";
import { linkDemoBank, makeTestApp, TEST_KEY } from "./test-helpers.js";

describe("token encryption", () => {
  const cipher = createCipher(TEST_KEY);

  it("round-trips and never stores plaintext", () => {
    const encrypted = cipher.encrypt("access-sandbox-secret-token", "item-1");
    expect(encrypted).not.toContain("secret-token");
    expect(cipher.decrypt(encrypted, "item-1")).toBe("access-sandbox-secret-token");
  });

  it("uses a fresh random IV every time", () => {
    expect(cipher.encrypt("same", "ctx")).not.toBe(cipher.encrypt("same", "ctx"));
  });

  it("rejects tampering, the wrong context, the wrong key, and bad formats", () => {
    const encrypted = cipher.encrypt("value", "item-1");
    const [format, payload] = encrypted.split(":");
    const bytes = Buffer.from(payload!, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(() => cipher.decrypt(`${format}:${bytes.toString("base64")}`, "item-1")).toThrow(
      /Could not decrypt/,
    );
    expect(() => cipher.decrypt(encrypted, "item-2")).toThrow(/Could not decrypt/);
    expect(() => createCipher("ef".repeat(32)).decrypt(encrypted, "item-1")).toThrow(
      /Could not decrypt/,
    );
    expect(() => cipher.decrypt("v9:abc", "x")).toThrow(/Unsupported/);
    expect(() => cipher.decrypt("v1:AAAA", "x")).toThrow(/truncated/);
  });

  it("requires a 32-byte key", () => {
    expect(() => createCipher("abcd")).toThrow(/32 bytes/);
  });
});

describe("encryption key resolution", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-key-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("uses the key provided by the desktop shell", () => {
    expect(
      resolveEncryptionKey({
        PF_ENCRYPTION_KEY: TEST_KEY,
        PF_ALLOW_DEV_ORIGIN: false,
        dataDir: dir,
      }),
    ).toBe(TEST_KEY);
  });

  it("refuses to run without a key outside development", () => {
    expect(() => resolveEncryptionKey({ PF_ALLOW_DEV_ORIGIN: false, dataDir: dir })).toThrow(
      /PF_ENCRYPTION_KEY is required/,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("rejects a malformed key", () => {
    expect(() =>
      resolveEncryptionKey({
        PF_ENCRYPTION_KEY: "nothex",
        PF_ALLOW_DEV_ORIGIN: true,
        dataDir: dir,
      }),
    ).toThrow(/64 hexadecimal/);
  });

  it("creates and then reuses a key file in development", () => {
    const first = resolveEncryptionKey({ PF_ALLOW_DEV_ORIGIN: true, dataDir: dir });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveEncryptionKey({ PF_ALLOW_DEV_ORIGIN: true, dataDir: dir })).toBe(first);
  });
});

describe("money conversion", () => {
  it("converts provider decimals to integer minor units", () => {
    expect(toMinorUnits(12.34, "USD")).toBe(1234);
    expect(toMinorUnits(0.1 + 0.2, "USD")).toBe(30);
    expect(toMinorUnits(-5.5, "USD")).toBe(-550);
    expect(toMinorUnits(23631.98, "USD")).toBe(2363198);
    expect(toMinorUnits(0, "USD")).toBe(0);
  });

  it("respects currencies with other decimal places", () => {
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("returns null when there is no amount", () => {
    expect(toMinorUnits(null, "USD")).toBeNull();
    expect(toMinorUnits(undefined, "USD")).toBeNull();
    expect(toMinorUnits(Number.NaN, "USD")).toBeNull();
  });
});

describe("real gateway (Plaid SDK mocked)", () => {
  function fakeApi() {
    return {
      linkTokenCreate: vi.fn().mockResolvedValue({
        data: { link_token: "link-sandbox-1", expiration: "2030-01-01T00:00:00Z" },
      }),
      itemPublicTokenExchange: vi
        .fn()
        .mockResolvedValue({ data: { access_token: "access-sandbox-1", item_id: "item-1" } }),
      itemGet: vi.fn().mockResolvedValue({
        data: { item: { item_id: "item-1", institution_id: "ins_1", error: null } },
      }),
      institutionsGetById: vi
        .fn()
        .mockResolvedValue({ data: { institution: { name: "Test Bank" } } }),
      accountsGet: vi.fn().mockResolvedValue({
        data: {
          accounts: [
            {
              account_id: "a1",
              name: "Card",
              official_name: null,
              type: "credit",
              subtype: "credit card",
              mask: "1234",
              balances: {
                current: 410,
                available: 1590,
                limit: 2000,
                iso_currency_code: "USD",
                unofficial_currency_code: null,
              },
            },
          ],
        },
      }),
      itemRemove: vi.fn().mockResolvedValue({ data: {} }),
    };
  }
  const gatewayWith = (api: ReturnType<typeof fakeApi>) =>
    new RealPlaidGateway("sandbox", api as unknown as PlaidApi);

  it("requests Transactions with the chosen history length for new connections", async () => {
    const api = fakeApi();
    await gatewayWith(api).createLinkToken({ userId: "u", daysRequested: 365 });
    const body = api.linkTokenCreate.mock.calls[0]![0];
    expect(body.products).toEqual(["transactions"]);
    expect(body.transactions).toEqual({ days_requested: 365 });
    expect(body.access_token).toBeUndefined();
    expect(body.redirect_uri).toBeUndefined();
  });

  it("uses update mode (access token, no products) for re-authentication", async () => {
    const api = fakeApi();
    await gatewayWith(api).createLinkToken({
      userId: "u",
      daysRequested: 365,
      updateAccessToken: "access-sandbox-1",
    });
    const body = api.linkTokenCreate.mock.calls[0]![0];
    expect(body.access_token).toBe("access-sandbox-1");
    expect(body.products).toBeUndefined();
    expect(body.transactions).toBeUndefined();
  });

  it("maps accounts, including the credit limit", async () => {
    const [card] = await gatewayWith(fakeApi()).getAccounts("access-sandbox-1");
    expect(card).toMatchObject({
      accountId: "a1",
      type: "credit",
      subtype: "credit card",
      mask: "1234",
      currentBalance: 410,
      creditLimit: 2000,
      currency: "USD",
    });
  });

  it("exchanges tokens and reads institution names", async () => {
    const gateway = gatewayWith(fakeApi());
    expect(await gateway.exchangePublicToken("public-sandbox-1")).toEqual({
      accessToken: "access-sandbox-1",
      itemId: "item-1",
    });
    expect(await gateway.getInstitutionName("ins_1")).toBe("Test Bank");
  });

  it("reports an Item that needs re-authentication", async () => {
    const api = fakeApi();
    api.itemGet.mockResolvedValue({
      data: {
        item: {
          item_id: "item-1",
          institution_id: "ins_1",
          error: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message: "technical",
            display_message: "Please sign in again",
          },
        },
      },
    });
    expect((await gatewayWith(api).getItem("t")).error).toEqual({
      code: "ITEM_LOGIN_REQUIRED",
      message: "Please sign in again",
    });
  });

  it("reduces Plaid HTTP errors to a safe summary without leaking the request", () => {
    const failure = toGatewayError({
      message: "Request failed with status code 400 PLAID-SECRET: super-secret",
      config: {
        headers: { "PLAID-SECRET": "super-secret" },
        data: '{"access_token":"access-leak"}',
      },
      response: {
        data: {
          error_type: "ITEM_ERROR",
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "technical",
          display_message: null,
          request_id: "r1",
        },
      },
    });
    expect(failure).toBeInstanceOf(PlaidGatewayError);
    expect(failure.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(
      JSON.stringify({ code: failure.code, message: failure.message, type: failure.type }),
    ).not.toMatch(/super-secret|access-leak/);
  });

  it("recognizes network failures and unknown errors", () => {
    expect(toGatewayError({ code: "ENOTFOUND" }).code).toBe("NETWORK_ERROR");
    expect(toGatewayError(new Error("boom with access-secret")).message).not.toContain(
      "access-secret",
    );
    expect(toGatewayError(new Error("boom")).code).toBe("UNKNOWN_ERROR");
  });
});

describe("gateway provider", () => {
  let ctx: ReturnType<typeof makeTestApp>;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("serves the built-in demo gateway by default", () => {
    expect(createGatewayProvider(ctx.db, ctx.cipher)().environment).toBe("fake");
  });

  it("requires saved credentials for Sandbox and Production", () => {
    updateSettings(ctx.db, { plaidEnvironment: "sandbox" });
    expect(() => createGatewayProvider(ctx.db, ctx.cipher)()).toThrow(/client ID and secret/);
  });

  it("builds the real gateway from the saved credentials and caches it", () => {
    updateSettings(ctx.db, { plaidEnvironment: "sandbox" });
    savePlaidCredentials(ctx.db, ctx.cipher, "sandbox", {
      clientId: "client-1",
      secret: "secret-1",
    });
    const factory = vi.fn().mockReturnValue({} as PlaidApi);
    const provider = createGatewayProvider(ctx.db, ctx.cipher, factory);
    const first = provider();
    expect(first.environment).toBe("sandbox");
    expect(provider()).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("sandbox", "client-1", "secret-1");
    savePlaidCredentials(ctx.db, ctx.cipher, "sandbox", {
      clientId: "client-1",
      secret: "secret-2",
    });
    expect(provider()).not.toBe(first);
  });
});

describe("Plaid connections (built-in demo gateway)", () => {
  let ctx: ReturnType<typeof makeTestApp>;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("requires the API token", async () => {
    const { default: request } = await import("supertest");
    await request(ctx.app).get("/api/plaid/items").set("Host", "127.0.0.1:47998").expect(401);
  });

  it("reports demo mode and which credentials are saved", async () => {
    const res = await ctx.call("get", "/api/plaid/status").expect(200);
    expect(res.body).toEqual({
      environment: "fake",
      linkMode: "fake",
      credentialsSaved: { sandbox: false, production: false },
    });
  });

  it("creates a link token", async () => {
    const res = await ctx.call("post", "/api/plaid/link-token").expect(200);
    expect(res.body.linkToken).toMatch(/^link-fake~new~/);
    expect(res.body.environment).toBe("fake");
  });

  it("links an institution, stores its accounts, and never returns or stores the token in plaintext", async () => {
    const { item } = await linkDemoBank(ctx.call);
    expect(item).toMatchObject({
      institutionName: "First Platypus Bank",
      status: "active",
      environment: "fake",
    });
    expect(item.accounts).toHaveLength(3);
    expect(JSON.stringify(item)).not.toMatch(/access-fake|accessToken|access_token/);

    const row = ctx.db.select().from(plaidItems).get()!;
    expect(row.accessTokenEncrypted).not.toContain("access-fake");
    expect(ctx.cipher.decrypt(row.accessTokenEncrypted, row.plaidItemId)).toBe(
      `access-fake~${row.plaidItemId}`,
    );
    expect(() => ctx.cipher.decrypt(row.accessTokenEncrypted, "some-other-item")).toThrow();
  });

  it("stores balances as integer minor units and masks only", async () => {
    await linkDemoBank(ctx.call);
    const res = await ctx.call("get", "/api/accounts").expect(200);
    const checking = res.body.find((a: { name: string }) => a.name === "Plaid Checking");
    expect(checking).toMatchObject({
      currentBalanceMinor: 11000,
      availableBalanceMinor: 10000,
      mask: "0000",
      currency: "USD",
      institutionName: "First Platypus Bank",
      source: "plaid",
      isManual: false,
    });
    expect(checking.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(checking)).not.toContain("accountNumber");
  });

  it("flags a second connection to the same institution without duplicating accounts", async () => {
    const first = await linkDemoBank(ctx.call);
    expect(first.duplicateOfItemId).toBeUndefined();
    const second = await linkDemoBank(ctx.call);
    expect(second.duplicateOfItemId).toBe(first.item.id);
    expect((await ctx.call("get", "/api/accounts")).body).toHaveLength(6); // distinct Plaid accounts per Item
    expect((await ctx.call("get", "/api/plaid/items")).body).toHaveLength(2);
  });

  it("rejects an invalid public token and saves nothing", async () => {
    const res = await ctx
      .call("post", "/api/plaid/exchange-token")
      .send({ publicToken: "garbage" })
      .expect(502);
    expect(res.body.error).toBe("plaid_error");
    expect(ctx.db.select().from(plaidItems).all()).toHaveLength(0);
  });

  it("validates the exchange request", async () => {
    await ctx.call("post", "/api/plaid/exchange-token").send({}).expect(400);
    await ctx.call("post", "/api/plaid/exchange-token").send({ publicToken: "" }).expect(400);
  });

  it("records the history length chosen in Settings on new connections", async () => {
    await ctx.call("patch", "/api/settings").send({ plaidDaysRequested: 90 }).expect(200);
    const { item } = await linkDemoBank(ctx.call);
    expect(item.daysRequested).toBe(90);
  });

  it("handles an expired login: detect, re-authenticate, recover", async () => {
    const { item } = await linkDemoBank(ctx.call);
    const broken = await ctx
      .call("post", `/api/plaid/fake/items/${item.id}/simulate-login-required`)
      .expect(200);
    expect(broken.body).toMatchObject({
      status: "login_required",
      lastErrorCode: "ITEM_LOGIN_REQUIRED",
    });
    expect((await ctx.call("get", "/api/plaid/items")).body[0].status).toBe("login_required");
    expect((await ctx.call("get", "/api/accounts")).body[0].connectionStatus).toBe(
      "login_required",
    );

    const link = await ctx.call("post", `/api/plaid/items/${item.id}/link-token`).expect(200);
    expect(link.body.linkToken).toMatch(/^link-fake~update~/);
    // Choosing accounts reuses the same connection: update mode with account selection.
    const choose = await ctx
      .call("post", `/api/plaid/items/${item.id}/link-token`)
      .send({ chooseAccounts: true })
      .expect(200);
    expect(choose.body.linkToken).toMatch(/^link-fake~choose~/);
    await ctx
      .call("post", `/api/plaid/items/${item.id}/link-token`)
      .send({ chooseAccounts: "yes" })
      .expect(400);

    const fixed = await ctx
      .call("post", `/api/plaid/items/${item.id}/reauthenticated`)
      .send({})
      .expect(200);
    expect(fixed.body).toMatchObject({
      status: "active",
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  });

  it("check reports a healthy connection", async () => {
    const { item } = await linkDemoBank(ctx.call);
    expect(
      (await ctx.call("post", `/api/plaid/items/${item.id}/check`).expect(200)).body.status,
    ).toBe("active");
  });

  it("disconnects an institution and deletes its accounts", async () => {
    const { item } = await linkDemoBank(ctx.call);
    await ctx.call("delete", `/api/plaid/items/${item.id}`).expect(204);
    expect((await ctx.call("get", "/api/plaid/items")).body).toEqual([]);
    expect(ctx.db.select().from(accounts).all()).toHaveLength(0);
    await ctx.call("delete", `/api/plaid/items/${item.id}`).expect(404);
  });

  it("returns 404 for unknown connections and 400 for bad ids", async () => {
    await ctx.call("post", "/api/plaid/items/999/check").expect(404);
    await ctx.call("post", "/api/plaid/items/abc/check").expect(400);
  });

  it("refuses to load a token that cannot be decrypted, with a clear message", async () => {
    const { item } = await linkDemoBank(ctx.call);
    ctx.db
      .update(plaidItems)
      .set({ accessTokenEncrypted: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
      .where(eq(plaidItems.id, item.id))
      .run();
    const res = await ctx.call("post", `/api/plaid/items/${item.id}/check`).expect(500);
    expect(res.body.error).toBe("token_unreadable");
    expect(res.body.message).toMatch(/encryption key/);
  });

  it("keeps accounts unique and preserves colors when upserting again", async () => {
    const { item } = await linkDemoBank(ctx.call);
    const before = ctx.db.select().from(accounts).all();
    const gateway = new FakePlaidGateway();
    const row = ctx.db.select().from(plaidItems).get()!;
    const incoming = await gateway.getAccounts(`access-fake~${row.plaidItemId}`);
    upsertItemAccounts(ctx.db, item.id, incoming, new Date().toISOString());
    upsertItemAccounts(ctx.db, item.id, incoming, new Date().toISOString());
    const after = ctx.db.select().from(accounts).all();
    expect(after).toHaveLength(before.length);
    expect(after.map((a) => a.color)).toEqual(before.map((a) => a.color));
  });
});

describe("Plaid connections: failure handling", () => {
  /** A demo gateway whose individual calls can be made to fail. */
  class FlakyGateway extends FakePlaidGateway {
    failAccounts: PlaidGatewayError | null = null;
    failRemove: PlaidGatewayError | null = null;
    override async getAccounts(accessToken: string) {
      if (this.failAccounts) throw this.failAccounts;
      return super.getAccounts(accessToken);
    }
    override async removeItem(accessToken: string) {
      if (this.failRemove) throw this.failRemove;
      return super.removeItem(accessToken);
    }
  }

  let gateway: FlakyGateway;
  let ctx: ReturnType<typeof makeTestApp>;
  beforeEach(() => {
    gateway = new FlakyGateway();
    ctx = makeTestApp({ getGateway: () => gateway });
  });
  afterEach(() => ctx.cleanup());

  it("keeps the token when loading accounts fails right after linking (network)", async () => {
    gateway.failAccounts = new PlaidGatewayError(
      "NETWORK_ERROR",
      "NETWORK",
      "Could not reach Plaid.",
    );
    const { item, warning } = await linkDemoBank(ctx.call);
    expect(warning).toMatch(/accounts could not be loaded/);
    expect(item.status).toBe("error");
    expect(ctx.db.select().from(plaidItems).all()).toHaveLength(1); // token not lost
  });

  it("marks the connection as needing re-authentication when linking ends with a login error", async () => {
    gateway.failAccounts = new PlaidGatewayError(
      "ITEM_LOGIN_REQUIRED",
      "ITEM_ERROR",
      "Sign in again.",
    );
    const { item } = await linkDemoBank(ctx.call);
    expect(item.status).toBe("login_required");
  });

  it("does not delete locally when Plaid cannot be reached, unless forced", async () => {
    const { item } = await linkDemoBank(ctx.call);
    gateway.failRemove = new PlaidGatewayError(
      "NETWORK_ERROR",
      "NETWORK",
      "Could not reach Plaid.",
    );
    const res = await ctx.call("delete", `/api/plaid/items/${item.id}`).expect(502);
    expect(res.body.error).toBe("disconnect_failed");
    expect(ctx.db.select().from(plaidItems).all()).toHaveLength(1);
    await ctx.call("delete", `/api/plaid/items/${item.id}?force=1`).expect(204);
    expect(ctx.db.select().from(plaidItems).all()).toHaveLength(0);
  });

  it("treats an Item Plaid no longer knows as already disconnected", async () => {
    const { item } = await linkDemoBank(ctx.call);
    gateway.failRemove = new PlaidGatewayError("ITEM_NOT_FOUND", "ITEM_ERROR", "Item not found.");
    await ctx.call("delete", `/api/plaid/items/${item.id}`).expect(204);
    expect(ctx.db.select().from(plaidItems).all()).toHaveLength(0);
  });

  it("leaves the status untouched when a check fails because of the network", async () => {
    const { item } = await linkDemoBank(ctx.call);
    gateway.getItem = async () => {
      throw new PlaidGatewayError("NETWORK_ERROR", "NETWORK", "Could not reach Plaid.");
    };
    const res = await ctx.call("post", `/api/plaid/items/${item.id}/check`).expect(503);
    expect(res.body.error).toBe("plaid_unreachable");
    expect(ctx.db.select().from(plaidItems).get()!.status).toBe("active");
  });
});

describe("Plaid credentials and environments", () => {
  let ctx: ReturnType<typeof makeTestApp>;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("saves credentials encrypted and never returns them", async () => {
    const res = await ctx
      .call("put", "/api/plaid/credentials")
      .send({ environment: "sandbox", clientId: "my-client-id", secret: "my-very-secret-value" })
      .expect(200);
    expect(res.body).toEqual({ credentialsSaved: { sandbox: true, production: false } });
    expect(JSON.stringify(res.body)).not.toMatch(/my-very-secret-value|my-client-id/);

    const rows = ctx.db.select().from(credentials).all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/my-very-secret-value|my-client-id/);

    const status = await ctx.call("get", "/api/plaid/status").expect(200);
    expect(JSON.stringify(status.body)).not.toMatch(/my-very-secret-value|my-client-id/);
    expect(status.body.credentialsSaved.sandbox).toBe(true);
  });

  it("validates and clears credentials", async () => {
    await ctx
      .call("put", "/api/plaid/credentials")
      .send({ environment: "staging", clientId: "a", secret: "b" })
      .expect(400);
    await ctx
      .call("put", "/api/plaid/credentials")
      .send({ environment: "sandbox", clientId: "", secret: "b" })
      .expect(400);
    await ctx
      .call("put", "/api/plaid/credentials")
      .send({ environment: "sandbox", clientId: "a", secret: "b" })
      .expect(200);
    const res = await ctx.call("delete", "/api/plaid/credentials/sandbox").expect(200);
    expect(res.body.credentialsSaved.sandbox).toBe(false);
    expect(ctx.db.select().from(credentials).all()).toHaveLength(0);
  });

  it("asks for credentials when Sandbox is selected without them", async () => {
    await ctx.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
    const res = await ctx.call("post", "/api/plaid/link-token").expect(409);
    expect(res.body.error).toBe("plaid_not_configured");
  });

  it("hides demo tools outside demo mode", async () => {
    await ctx.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
    await ctx.call("get", "/api/plaid/fake/institutions").expect(404);
  });

  it("keeps connections separated by environment", async () => {
    const { item } = await linkDemoBank(ctx.call);
    await ctx
      .call("put", "/api/plaid/credentials")
      .send({ environment: "sandbox", clientId: "c", secret: "s" })
      .expect(200);
    await ctx.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
    expect((await ctx.call("get", "/api/plaid/items")).body).toEqual([]);
    expect((await ctx.call("get", "/api/accounts")).body).toEqual([]);
    const res = await ctx.call("post", `/api/plaid/items/${item.id}/check`).expect(409);
    expect(res.body.error).toBe("wrong_environment");
    // Switching back shows the demo connection again; nothing was deleted.
    await ctx.call("patch", "/api/settings").send({ plaidEnvironment: "fake" }).expect(200);
    expect((await ctx.call("get", "/api/plaid/items")).body).toHaveLength(1);
  });
});
