import os from "node:os";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  /** Loopback port the API listens on. Tauri picks a free one and passes it in. */
  PF_PORT: z.coerce.number().int().min(1024).max(65535).default(47831),
  /** Folder holding the SQLite database. */
  PF_DATA_DIR: z.string().min(1).optional(),
  /** Per-launch secret every /api request must present. There is deliberately no default. */
  PF_TOKEN: z.string().min(8, "PF_TOKEN must be at least 8 characters"),
  /** Built frontend to serve for the browser-tab option. */
  PF_STATIC_DIR: z.string().min(1).optional(),
  /** Folder with the Drizzle SQL migrations. */
  PF_MIGRATIONS_DIR: z.string().min(1).optional(),
  /** Folder holding better_sqlite3.node when running as a single executable. */
  PF_NATIVE_DIR: z.string().min(1).optional(),
  /** If set, exit when this process disappears (so a crashed app never leaves a backend behind). */
  PF_PARENT_PID: z.coerce.number().int().positive().optional(),
  /** 64 hex characters (32 bytes). Normally supplied by Tauri from the Windows Credential Manager. */
  PF_ENCRYPTION_KEY: z.string().optional(),
  PF_VERSION: z.string().default("0.1.0"),
  /** Development only (set in .env): accept requests from the Vite dev server. Never set by Tauri. */
  PF_ALLOW_DEV_ORIGIN: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
});

export type Env = z.infer<typeof envSchema> & {
  dataDir: string;
  migrationsDir: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names and problems only, never the values (PF_TOKEN is a secret).
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const env = parsed.data;
  return {
    ...env,
    dataDir: env.PF_DATA_DIR ?? path.join(process.env.APPDATA ?? os.homedir(), "PersonalFinance"),
    migrationsDir:
      env.PF_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "..", "drizzle", "migrations"),
  };
}
