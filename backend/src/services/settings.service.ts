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
  /** Sidebar pages the user hid (paths). Dashboard and Settings can never be hidden. */
  navHidden: z.array(z.string().max(60)).max(60),
  /**
   * The names you go by on bank descriptions ("Jane Doe", a Cash App name). Money sent to or from
   * them is moving your own money (Transfers > Own Accounts), never income or spending.
   */
  ownNames: z.array(z.string().trim().min(3).max(60)).max(10),
  /**
   * The extra paid toward debt each month under the debt payoff plan, counted in the cash forecast
   * (and so in safe-to-spend) until the plan pays the debts off. 0: not counted.
   */
  debtExtraInForecastMinor: z.number().int().min(0).max(100_000_000_000),
  /**
   * Hold back what is left of this month's spending caps in the cash forecast (and so in
   * safe-to-spend), spread over the rest of the month.
   */
  forecastHoldCaps: z.boolean(),
  /**
   * The income that safe-to-spend counts up to: `recurring:<series key>` or `expected:<planned
   * id>`. null: the next money coming in, whatever it is.
   */
  briefIncomeKey: z.string().max(200).nullable(),
  /** The user said they saved the recovery key somewhere safe (asked until they do). */
  recoveryKeySaved: z.boolean(),
  /** The user closed the first-run welcome. */
  welcomeDismissed: z.boolean(),
  /** The ready-made dashboards have been added, once, so deleting one does not bring it back. */
  dashboardViewsAdded: z.boolean(),
  /**
   * Desktop notifications, each off until the user turns it on: payments due in the next few
   * days, banks that need a fresh sign-in, and budgets nearly or fully used.
   */
  reminders: z.object({ bills: z.boolean(), signIn: z.boolean(), budgets: z.boolean() }).strict(),
  /**
   * The categories the user cannot go without (rent, groceries, utilities): what the safety net
   * counts a month of. A parent includes its subcategories. Empty: all spending counts.
   */
  essentialCategoryIds: z.array(z.number().int().positive()).max(500),
  /**
   * Load map images from OpenFreeMap on the Places page. Off by default: the map host would see
   * which areas are viewed (never the transactions), and the app otherwise contacts no one.
   */
  mapTilesOnline: z.boolean(),
  /**
   * Look up street addresses that came without coordinates, with Nominatim (OpenStreetMap's
   * geocoder), when the user starts it. Off by default. Only the shop's address is sent.
   */
  geocodeEnabled: z.boolean(),
  /**
   * The Nominatim server to ask. A setting, so the service can be switched (the usage policy asks
   * apps to be able to) without a new version.
   */
  geocodeServer: z
    .string()
    .url()
    .max(200)
    .refine((u) => /^https:\/\//.test(u), "Use an https:// address."),
  /**
   * A random tag for this copy of the app, made once, sent beside the app's name to the address
   * lookup server so it can tell copies apart. Nothing personal; null until the first lookup.
   */
  geocodeInstallId: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .nullable(),
  /** When every saved address answer was last cleared to be asked again (at most once a week). */
  geocodeResetAt: z.string().nullable(),
  /** The Places map's colours: following the app's light or dark look, or always one. */
  mapTheme: z.enum(["auto", "light", "dark"]),
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
  navHidden: [],
  ownNames: [],
  debtExtraInForecastMinor: 0,
  forecastHoldCaps: false,
  briefIncomeKey: null,
  recoveryKeySaved: false,
  welcomeDismissed: false,
  dashboardViewsAdded: false,
  reminders: { bills: false, signIn: false, budgets: false },
  essentialCategoryIds: [],
  mapTilesOnline: false,
  geocodeEnabled: false,
  geocodeServer: "https://nominatim.openstreetmap.org",
  geocodeInstallId: null,
  geocodeResetAt: null,
  mapTheme: "auto",
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
