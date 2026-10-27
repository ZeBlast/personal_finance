import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, runMigrations, type AppDb } from "./db/client.js";
import { createCipher } from "./services/crypto.js";
import { TEST_DB_KEY } from "./test-helpers.js";

const cipher = createCipher("ab".repeat(32));
const PORT = 47999;
const TOKEN = "test-token-123";
const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle/migrations");

let dir: string;
let close: () => void;
let testDb: AppDb;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-"));
  const { db, sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
  runMigrations(db, MIGRATIONS);
  testDb = db;
  app = createApp({ db, port: PORT, token: TOKEN, version: "9.9.9", cipher });
  close = () => sqlite.close();
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method: "get" | "patch" | "options", url: string) =>
  request(app)[method](url).set("Host", `127.0.0.1:${PORT}`);

describe("security", () => {
  it("rejects requests without a token", async () => {
    await call("get", "/api/health").expect(401);
  });

  it("rejects a wrong token", async () => {
    await call("get", "/api/health").set("x-pf-token", "nope-nope-nope").expect(401);
  });

  it("accepts the token as a header", async () => {
    const res = await call("get", "/api/health").set("x-pf-token", TOKEN).expect(200);
    expect(res.body).toEqual({ ok: true, database: true, version: "9.9.9" });
  });

  it("accepts the token as a cookie", async () => {
    await call("get", "/api/health").set("Cookie", `pf_token=${TOKEN}`).expect(200);
  });

  it("rejects an unexpected Host header (DNS rebinding)", async () => {
    await request(app)
      .get("/api/health")
      .set("Host", "evil.example.com")
      .set("x-pf-token", TOKEN)
      .expect(403);
  });

  it("rejects a foreign Origin", async () => {
    await call("get", "/api/health")
      .set("Origin", "https://evil.example.com")
      .set("x-pf-token", TOKEN)
      .expect(403);
  });

  it("allows the Tauri webview origin with CORS headers", async () => {
    const res = await call("get", "/api/health")
      .set("Origin", "http://tauri.localhost")
      .set("x-pf-token", TOKEN)
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
  });

  it("refuses the Vite dev-server origin unless dev mode is enabled", async () => {
    await call("get", "/api/health")
      .set("Origin", "http://127.0.0.1:1420")
      .set("x-pf-token", TOKEN)
      .expect(403);
  });

  it("accepts the Vite dev-server origin when dev mode is enabled", async () => {
    const devApp = createApp({
      db: testDb,
      port: PORT,
      token: TOKEN,
      version: "9.9.9",
      cipher,
      allowDevOrigin: true,
    });
    const res = await request(devApp)
      .get("/api/health")
      .set("Host", `127.0.0.1:${PORT}`)
      .set("Origin", "http://127.0.0.1:1420")
      .set("x-pf-token", TOKEN)
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:1420");
  });

  it("answers preflight without a token", async () => {
    await call("options", "/api/settings").set("Origin", "http://tauri.localhost").expect(204);
  });

  it("sets a cookie and redirects when opened with the token", async () => {
    const res = await call("get", `/?token=${TOKEN}`).expect(302);
    expect(res.headers["location"]).toBe("/");
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("refuses the browser bootstrap with a wrong token", async () => {
    await call("get", "/?token=wrong-wrong-wrong").expect(401);
  });

  it("returns 404 for unknown API routes", async () => {
    await call("get", "/api/nope").set("x-pf-token", TOKEN).expect(404);
  });
});

describe("settings", () => {
  const authed = (method: "get" | "patch") =>
    call(method, "/api/settings").set("x-pf-token", TOKEN);

  it("returns defaults on a fresh database", async () => {
    const res = await authed("get").expect(200);
    expect(res.body).toEqual({
      syncCooldownMinutes: 5,
      theme: "system",
      currency: "USD",
      autoSyncIntervalMinutes: 0,
      plaidEnvironment: "fake",
      plaidDaysRequested: 730,
      autoBackupEnabled: true,
      backupsToKeep: 10,
      activeDashboardId: 1,
      navOrder: [],
      ownNames: [],
      debtExtraInForecastMinor: 0,
      recoveryKeySaved: false,
      welcomeDismissed: false,
    });
  });

  it("validates the editable sync timing settings", async () => {
    await authed("patch").send({ syncCooldownMinutes: -5 }).expect(400);
    await authed("patch").send({ syncCooldownMinutes: 1.5 }).expect(400);
    await authed("patch").send({ autoSyncIntervalMinutes: 99999 }).expect(400);
    const res = await authed("patch")
      .send({ syncCooldownMinutes: 0, autoSyncIntervalMinutes: 15 })
      .expect(200);
    expect(res.body).toMatchObject({ syncCooldownMinutes: 0, autoSyncIntervalMinutes: 15 });
  });

  it("persists valid changes", async () => {
    await authed("patch").send({ syncCooldownMinutes: 90, theme: "dark" }).expect(200);
    const res = await authed("get").expect(200);
    expect(res.body).toMatchObject({ syncCooldownMinutes: 90, theme: "dark", currency: "USD" });
  });

  it("validates the Plaid settings", async () => {
    await authed("patch").send({ plaidEnvironment: "staging" }).expect(400);
    await authed("patch").send({ plaidDaysRequested: 5 }).expect(400);
    await authed("patch").send({ plaidDaysRequested: 9999 }).expect(400);
    await authed("patch").send({ plaidEnvironment: "sandbox", plaidDaysRequested: 90 }).expect(200);
  });

  it("rejects invalid values and unknown keys", async () => {
    await authed("patch").send({ syncCooldownMinutes: -1 }).expect(400);
    await authed("patch").send({ currency: "dollars" }).expect(400);
    await authed("patch").send({ somethingElse: true }).expect(400);
  });
});

describe("database", () => {
  it("applies migrations repeatedly without error", () => {
    const { db, sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(() => {
      runMigrations(db, MIGRATIONS);
      runMigrations(db, MIGRATIONS);
    }).not.toThrow();
    sqlite.close();
  });

  it("fails clearly when migrations are missing", () => {
    const { db, sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(() => runMigrations(db, path.join(dir, "nothing-here"))).toThrow(/Migrations not found/);
    sqlite.close();
  });

  it("enables foreign keys and WAL", () => {
    const { sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    sqlite.close();
  });
});

describe("configuration", () => {
  it("requires a token and never echoes its value", () => {
    expect(() => loadEnv({})).toThrow(/PF_TOKEN/);
    expect(() => loadEnv({ PF_TOKEN: "short" })).toThrow(/at least 8/);
    try {
      loadEnv({ PF_TOKEN: "short", PF_PORT: "abc" });
    } catch (e) {
      expect(String(e)).not.toContain("short,");
    }
  });

  it("applies defaults", () => {
    const env = loadEnv({ PF_TOKEN: "long-enough-token" });
    expect(env.PF_PORT).toBe(47831);
    expect(env.dataDir.length).toBeGreaterThan(0);
  });

  it("keeps dev-origin access off unless explicitly enabled", () => {
    expect(loadEnv({ PF_TOKEN: "long-enough-token" }).PF_ALLOW_DEV_ORIGIN).toBe(false);
    expect(
      loadEnv({ PF_TOKEN: "long-enough-token", PF_ALLOW_DEV_ORIGIN: "1" }).PF_ALLOW_DEV_ORIGIN,
    ).toBe(true);
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadEnv({ PF_TOKEN: "long-enough-token", PF_PORT: "80" })).toThrow(/PF_PORT/);
  });
});
