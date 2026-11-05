import { eq } from "drizzle-orm";
import { z } from "zod";
import { forecastScenarios } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { notFound } from "../utils/errors.js";
import { cashForecast, lowestBalance, type Forecast } from "./forecast.service.js";
import type { Cadence } from "./recurring.service.js";

/**
 * Named what-ifs for the cash forecast ("what if I drop the gym", "what if rent goes up"). A
 * scenario is only a list of adjustments saved by name: the forecast lays them over its own copy of
 * its inputs each time it runs, so nothing here ever touches the ledger, the plan, goals or settings.
 */

export type ScenarioAdjustment =
  /** Money in (+) or out (-) on one day. Never 0. */
  | { kind: "one_off"; label: string; date: string; amountMinor: number }
  | {
      kind: "recurring";
      label: string;
      amountMinor: number;
      cadence: Cadence;
      startDate: string;
      endDate: string | null;
    }
  /** An expected or detected series from a day on: a new amount (positive, keeping its direction), or null to stop it. */
  | {
      kind: "change_series";
      target: { seriesKey: string } | { plannedId: number };
      fromDate: string;
      amountMinor: number | null;
    }
  /** A goal's counted monthly contribution replaced, or (null) not counted. */
  | { kind: "goal"; goalId: number; forecast: { monthlyMinor: number; day: number } | null };

const MAX_AMOUNT = 100_000_000_000;
const day = z.string().refine(isRealDate, "Use a real day (YYYY-MM-DD).");
const label = z.string().trim().min(1).max(80);
const cadence = z.enum(["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "yearly"]);

export const adjustmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("one_off"),
      label,
      date: day,
      amountMinor: z
        .number()
        .int()
        .min(-MAX_AMOUNT)
        .max(MAX_AMOUNT)
        .refine((n) => n !== 0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recurring"),
      label,
      amountMinor: z
        .number()
        .int()
        .min(-MAX_AMOUNT)
        .max(MAX_AMOUNT)
        .refine((n) => n !== 0),
      cadence,
      startDate: day,
      endDate: day.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("change_series"),
      target: z.union([
        z.object({ seriesKey: z.string().min(1).max(500) }).strict(),
        z.object({ plannedId: z.number().int().positive() }).strict(),
      ]),
      fromDate: day,
      amountMinor: z.number().int().min(1).max(MAX_AMOUNT).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("goal"),
      goalId: z.number().int().positive(),
      forecast: z
        .object({
          monthlyMinor: z.number().int().min(1).max(MAX_AMOUNT),
          day: z.number().int().min(1).max(28),
        })
        .strict()
        .nullable(),
    })
    .strict(),
]);

export const scenarioBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    adjustments: z.array(adjustmentSchema).max(50),
  })
  .strict();

export interface ScenarioDto {
  id: number;
  name: string;
  adjustments: ScenarioAdjustment[];
  /** Stored adjustments that could not be read and were left out. */
  skipped: number;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof forecastScenarios.$inferSelect): ScenarioDto {
  let stored: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.adjustments);
    if (Array.isArray(parsed)) stored = parsed;
  } catch {
    // Unreadable: treated as no adjustments.
  }
  const adjustments: ScenarioAdjustment[] = [];
  for (const entry of stored) {
    const ok = adjustmentSchema.safeParse(entry);
    if (ok.success) adjustments.push(ok.data);
  }
  return {
    id: row.id,
    name: row.name,
    adjustments,
    skipped: stored.length - adjustments.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function get(db: AppDb, id: number): ScenarioDto {
  const row = db.select().from(forecastScenarios).where(eq(forecastScenarios.id, id)).get();
  if (!row) throw notFound("That scenario");
  return toDto(row);
}

export function listScenarios(db: AppDb): ScenarioDto[] {
  return db.select().from(forecastScenarios).orderBy(forecastScenarios.name).all().map(toDto);
}

export function createScenario(
  db: AppDb,
  input: { name: string; adjustments: ScenarioAdjustment[] },
  now = new Date().toISOString(),
): ScenarioDto {
  const row = db
    .insert(forecastScenarios)
    .values({
      name: input.name,
      adjustments: JSON.stringify(input.adjustments),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(row);
}

export function updateScenario(
  db: AppDb,
  id: number,
  input: { name: string; adjustments: ScenarioAdjustment[] },
  now = new Date().toISOString(),
): ScenarioDto {
  get(db, id);
  db.update(forecastScenarios)
    .set({ name: input.name, adjustments: JSON.stringify(input.adjustments), updatedAt: now })
    .where(eq(forecastScenarios.id, id))
    .run();
  return get(db, id);
}

export function deleteScenario(db: AppDb, id: number): void {
  get(db, id);
  db.delete(forecastScenarios).where(eq(forecastScenarios.id, id)).run();
}

/** The forecast as it is and as it would be with the scenario, and how the lowest and last days differ (scenario minus now). The lowest is the screens' figure: after today when today is the low point. */
export function compareScenario(
  db: AppDb,
  id: number,
  opts: { days?: number | undefined; today?: string | undefined } = {},
): {
  scenario: ScenarioDto;
  base: Forecast;
  alt: Forecast;
  lowestChangeMinor: number;
  endChangeMinor: number;
  /** Indexes of adjustments whose series, plan or goal was not found in this forecast. */
  unmatched: number[];
} {
  const scenario = get(db, id);
  const base = cashForecast(db, { days: opts.days, today: opts.today });
  const matched = new Set<number>();
  const alt = cashForecast(db, {
    days: opts.days,
    today: base.today,
    adjustments: scenario.adjustments,
    matched,
  });
  // A change that finds nothing, or whose days are all before today (the forecast starts tomorrow).
  const before = (a: ScenarioAdjustment): boolean =>
    (a.kind === "one_off" && a.date <= base.today) ||
    (a.kind === "recurring" && a.endDate !== null && a.endDate <= base.today);
  const unmatched = scenario.adjustments
    .map((a, i) =>
      ((a.kind === "change_series" || a.kind === "goal") && !matched.has(i)) || before(a) ? i : -1,
    )
    .filter((i) => i >= 0);
  return {
    scenario,
    base,
    alt,
    unmatched,
    lowestChangeMinor: lowestBalance(alt) - lowestBalance(base),
    endChangeMinor: alt.endBalanceMinor - base.endBalanceMinor,
  };
}
