import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSettings } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";

/** Every known setting with its validation and default. Unknown keys are rejected. */
export const settingsSchema = z.object({
  /** Minimum minutes between automatic launch syncs; the sync button ignores it. */
  syncCooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  theme: z.enum(["system", "light", "dark"]),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code"),
  /**
   * While the app stays open, also sync automatically this often (0 = only at launch and when the
   * Sync button is used). Read again at every check, so changing it applies immediately.
   */
  autoSyncIntervalMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  /** Which Plaid environment the app talks to; `fake` is the built-in demo data. */
  plaidEnvironment: z.enum(["fake", "sandbox", "production"]),
  /** History length requested for NEW connections (Plaid fixes it when the Item is created). */
  plaidDaysRequested: z.number().int().min(30).max(730),
  /** Take an automatic backup of the database before the launch sync (at most twice a day). */
  autoBackupEnabled: z.boolean(),
  /** How many automatic backups to keep; older ones are removed. Manual backups are never removed. */
  backupsToKeep: z.number().int().min(1).max(50),
  /** The dashboard being shown (see the dashboards table). Falls back to the first if it is gone. */
  activeDashboardId: z.number().int().min(1),
  /** The sidebar's pages in the order the user dragged them into (paths); empty is the usual order. */
  navOrder: z.array(z.string().max(60)).max(60),
});

export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
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
};

export function getSettings(db: AppDb): Settings {
  const rows = db.select().from(appSettings).all();
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupt value falls back to the default instead of breaking the app.
    }
  }
  const merged = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
  return merged.success ? merged.data : DEFAULT_SETTINGS;
}

export function updateSettings(db: AppDb, patch: SettingsPatch): Settings {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      tx.insert(appSettings)
        .values({ key, value: JSON.stringify(value), updatedAt: now })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: JSON.stringify(value), updatedAt: now },
        })
        .run();
    }
  });
  return getSettings(db);
}

export function deleteSetting(db: AppDb, key: string): void {
  db.delete(appSettings).where(eq(appSettings.key, key)).run();
}
