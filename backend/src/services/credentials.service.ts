import { eq, inArray } from "drizzle-orm";
import { credentials } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import type { TokenCipher } from "./crypto.js";

export type CredentialEnvironment = "sandbox" | "production";

export interface PlaidCredentials {
  clientId: string;
  secret: string;
}

const clientIdKey = (env: CredentialEnvironment) => `plaid.${env}.client_id`;
const secretKey = (env: CredentialEnvironment) => `plaid.${env}.secret`;

/** Anything with `insert`: the database itself or a transaction on it. */
type Writer = Pick<AppDb, "insert">;

function put(db: Writer, cipher: TokenCipher, key: string, value: string): void {
  const now = new Date().toISOString();
  const valueEncrypted = cipher.encrypt(value, key);
  db.insert(credentials)
    .values({ key, valueEncrypted, updatedAt: now })
    .onConflictDoUpdate({ target: credentials.key, set: { valueEncrypted, updatedAt: now } })
    .run();
}

export function savePlaidCredentials(
  db: AppDb,
  cipher: TokenCipher,
  environment: CredentialEnvironment,
  creds: PlaidCredentials,
): void {
  db.transaction((tx) => {
    put(tx, cipher, clientIdKey(environment), creds.clientId);
    put(tx, cipher, secretKey(environment), creds.secret);
  });
}

export function loadPlaidCredentials(
  db: AppDb,
  cipher: TokenCipher,
  environment: CredentialEnvironment,
): PlaidCredentials | null {
  const keys = [clientIdKey(environment), secretKey(environment)];
  const rows = db.select().from(credentials).where(inArray(credentials.key, keys)).all();
  const byKey = new Map(rows.map((row) => [row.key, row.valueEncrypted]));
  const clientId = byKey.get(keys[0]!);
  const secret = byKey.get(keys[1]!);
  if (!clientId || !secret) return null;
  return {
    clientId: cipher.decrypt(clientId, keys[0]!),
    secret: cipher.decrypt(secret, keys[1]!),
  };
}

export function clearPlaidCredentials(db: AppDb, environment: CredentialEnvironment): void {
  db.delete(credentials)
    .where(eq(credentials.key, clientIdKey(environment)))
    .run();
  db.delete(credentials)
    .where(eq(credentials.key, secretKey(environment)))
    .run();
}

/** Which environments have credentials saved. Reports presence only, never the values. */
export function credentialStatus(db: AppDb): Record<CredentialEnvironment, boolean> {
  const keys = new Set(
    db
      .select({ key: credentials.key })
      .from(credentials)
      .all()
      .map((r) => r.key),
  );
  const has = (env: CredentialEnvironment) =>
    keys.has(clientIdKey(env)) && keys.has(secretKey(env));
  return { sandbox: has("sandbox"), production: has("production") };
}
