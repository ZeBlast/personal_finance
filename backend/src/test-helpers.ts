import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp, type AppOptions } from "./app.js";
import { createDb, runMigrations, type AppDb } from "./db/client.js";
import { FakePlaidGateway } from "./plaid/fake-gateway.js";
import { createCipher, type TokenCipher } from "./services/crypto.js";
import { createSyncService, type SyncService } from "./services/sync.service.js";

export const TEST_PORT = 47998;
export const TEST_TOKEN = "helper-token-1234";
export const TEST_KEY = "cd".repeat(32);
const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle/migrations");

type Method = "get" | "post" | "put" | "patch" | "delete";

type Overrides =
  Partial<AppOptions> | ((deps: { db: AppDb; cipher: TokenCipher }) => Partial<AppOptions>);

/**
 * A fully wired app on a throwaway database, plus helpers that add the Host and token headers.
 * `overrides` may be a function, for options that need the database or cipher (such as a sync
 * service with a controllable clock).
 */
export function makeTestApp(overrides: Overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-"));
  const { db, sqlite } = createDb({ dataDir: dir });
  runMigrations(db, MIGRATIONS);
  const cipher = createCipher(TEST_KEY);
  const extra = typeof overrides === "function" ? overrides({ db, cipher }) : overrides;
  const app = createApp({
    db,
    port: TEST_PORT,
    token: TEST_TOKEN,
    version: "test",
    cipher,
    dataDir: dir,
    migrationsDir: MIGRATIONS,
    ...extra,
  });

  const call = (method: Method, url: string) =>
    request(app)[method](url).set("Host", `127.0.0.1:${TEST_PORT}`).set("x-pf-token", TEST_TOKEN);

  return {
    app,
    db,
    sqlite,
    cipher,
    call,
    cleanup() {
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A test app whose demo bank and sync service share a clock the test controls, so tests can sync,
 * move forward in time, and sync again.
 */
export function makeSyncHarness(startIso = "2026-09-01T12:00:00Z") {
  const clock = { now: new Date(startIso) };
  const gateway = new FakePlaidGateway({ now: () => clock.now, pageSize: 25 });
  let sync!: SyncService;
  const ctx = makeTestApp(({ db, cipher }) => {
    sync = createSyncService({ db, cipher, getGateway: () => gateway, now: () => clock.now });
    return { getGateway: () => gateway, sync };
  });
  return {
    ...ctx,
    gateway,
    sync,
    clock,
    advanceDays(days: number) {
      clock.now = new Date(clock.now.getTime() + days * 24 * 60 * 60_000);
    },
  };
}

/** Links the built-in demo bank and returns the API's response body. */
export async function linkDemoBank(
  call: ReturnType<typeof makeTestApp>["call"],
  institutionId = "ins_fake_bank",
  name = "First Platypus Bank",
) {
  const res = await call("post", "/api/plaid/exchange-token")
    .send({
      publicToken: `public-fake~${institutionId}~abc`,
      institution: { id: institutionId, name },
    })
    .expect(201);
  return res.body as {
    item: { id: number; status: string; accounts: Array<Record<string, unknown>> } & Record<
      string,
      unknown
    >;
    warning?: string;
    duplicateOfItemId?: number;
  };
}
