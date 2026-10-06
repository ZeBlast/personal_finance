import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts and decrypts short secrets (Plaid access tokens, API credentials). */
export interface TokenCipher {
  /**
   * `context` is authenticated but not encrypted (AES-GCM "associated data"). Using the owner's
   * identity (for example the Plaid item ID) means an encrypted value copied onto a different
   * row fails to decrypt.
   */
  encrypt(plaintext: string, context: string): string;
  decrypt(encrypted: string, context: string): string;
}

export function createCipher(keyHex: string): TokenCipher {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (64 hex characters)");

  return {
    encrypt(plaintext, context) {
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${FORMAT}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
    },

    decrypt(encrypted, context) {
      const [format, payload] = encrypted.split(":");
      if (format !== FORMAT || !payload) throw new Error("Unsupported encrypted value format");
      const raw = Buffer.from(payload, "base64");
      if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted value is truncated");
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const body = raw.subarray(IV_BYTES + TAG_BYTES);
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        // Deliberately vague: do not reveal whether the key, the data, or the context was wrong.
        throw new Error("Could not decrypt value (wrong key or corrupted data)");
      }
    },
  };
}

export function generateKeyHex(): string {
  return crypto.randomBytes(32).toString("hex");
}

const KEY_PATTERN = /^[0-9a-f]{64}$/i;

export function isValidKeyHex(value: string): boolean {
  return KEY_PATTERN.test(value);
}

interface KeySource {
  PF_ENCRYPTION_KEY?: string | undefined;
  /** True only for development runs (set from .env); never true for the installed app. */
  PF_ALLOW_DEV_ORIGIN: boolean;
  dataDir: string;
}

/**
 * The installed app gets its key from Tauri (stored in the Windows Credential Manager, outside
 * the app's data folder). In development there is no Tauri, so a throwaway key file is created
 * in the data folder instead.
 */
export function resolveEncryptionKey(source: KeySource): string {
  if (source.PF_ENCRYPTION_KEY !== undefined && source.PF_ENCRYPTION_KEY !== "") {
    if (!isValidKeyHex(source.PF_ENCRYPTION_KEY)) {
      throw new Error("PF_ENCRYPTION_KEY must be 64 hexadecimal characters");
    }
    return source.PF_ENCRYPTION_KEY;
  }
  if (!source.PF_ALLOW_DEV_ORIGIN) {
    throw new Error("PF_ENCRYPTION_KEY is required (it is normally provided by the desktop shell)");
  }

  const file = path.join(source.dataDir, "dev-encryption.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(source.dataDir, { recursive: true });
  const key = generateKeyHex();
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}
