import { Router } from "express";
import { z } from "zod";
import { DATE_BASES } from "../services/analytics.service.js";
import type { AppDb } from "../db/client.js";
import {
  calendarOverlay,
  changeOccurrence,
  createPlanned,
  deletePlanned,
  expectedEvents,
  getPlanned,
  listNotes,
  listOccurrences,
  listPlanned,
  periodSummary,
  previewRule,
  recordOccurrence,
  setNote,
  setOccurrenceStatus,
  updatePlanned,
} from "../services/calendar.service.js";
import { getSettings } from "../services/settings.service.js";
import { calendarForecast } from "../services/forecast.service.js";
import { FREQUENCIES } from "../utils/recurrence.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM");
const idParam = z.coerce.number().int().positive();
const accountQuery = z.coerce.number().int().positive().optional();

const rangeQuery = z.object({
  from: date,
  to: date,
  accountId: accountQuery,
  dateBasis: z.enum(DATE_BASES).optional(),
});
const noteBody = z.object({ note: z.string().max(4000) }).strict();

const plannedBody = z
  .object({
    merchant: z.string().min(1).max(200),
    amountMinor: z.number().int().min(1).max(100_000_000_000),
    direction: z.enum(["out", "in"]),
    accountId: z.number().int().positive().nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    person: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    startDate: date,
    frequency: z.enum(FREQUENCIES),
    repeatEvery: z.number().int().min(1).max(365).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    monthMode: z.enum(["day", "weekday"]).nullable().optional(),
    dayOfMonth: z.number().int().min(-1).max(31).nullable().optional(),
    nthWeek: z.number().int().min(-1).max(4).nullable().optional(),
    endDate: date.nullable().optional(),
    maxCount: z.number().int().min(1).max(5000).nullable().optional(),
  })
  .strict();

const previewBody = z.object({
  rule: plannedBody.partial({ merchant: true, amountMinor: true, direction: true }),
  from: date.optional(),
});

const statusBody = z.object({ status: z.enum(["skipped", "done", "expected"]) }).strict();

/** Day notes, expected transactions, and the calendar's balance and summary figures. */
export function calendarRoutes(db: AppDb): Router {
  const router = Router();
  const now = (): string => new Date().toISOString();
  const environment = (): string => getSettings(db).plaidEnvironment;

  /** Notes and expected amounts for the grid of one month. */
  router.get("/calendar/overlay", (req, res) => {
    const q = z.object({ month, accountId: accountQuery }).parse(req.query);
    res.json(calendarOverlay(db, q.month, q.accountId));
  });

  /** The balance, what changed, and what happened, for a day (from = to) or a span of days. */
  router.get("/calendar/summary", (req, res) => {
    const q = rangeQuery.parse(req.query);
    res.json(periodSummary(db, q.from, q.to, q.accountId, environment(), undefined, q.dateBasis));
  });

  /**
   * What is still expected in a span: planned occurrences and pending manual entries, the same list
   * the grid and the summary count. With includeResolved=1, skipped and done ones too.
   */
  router.get("/calendar/expected", (req, res) => {
    const q = rangeQuery
      .extend({ includeResolved: z.enum(["0", "1"]).optional() })
      .parse(req.query);
    res.json(
      expectedEvents(db, q.from, q.to, {
        accountId: q.accountId,
        includeResolved: q.includeResolved === "1",
      }),
    );
  });

  /**
   * The cash forecast for the days ahead in a span: projected cash in the bank accounts, with
   * card bills, detected recurring items, plans and pending entries (see forecast.service.ts).
   */
  router.get("/calendar/forecast", (req, res) => {
    const q = rangeQuery.pick({ from: true, to: true }).parse(req.query);
    res.json(calendarForecast(db, q.from, q.to));
  });

  router.get("/calendar/notes", (req, res) => {
    const q = rangeQuery.pick({ from: true, to: true }).parse(req.query);
    res.json(listNotes(db, q.from, q.to));
  });

  /** Saves a day's note; an empty note removes it. */
  router.put("/calendar/notes/:date", (req, res) => {
    const day = date.parse(req.params["date"]);
    const saved = setNote(db, day, noteBody.parse(req.body).note, now());
    res.json({ date: day, note: saved?.note ?? "" });
  });

  router.get("/planned", (_req, res) => {
    res.json(listPlanned(db));
  });

  router.get("/planned/occurrences", (req, res) => {
    const q = rangeQuery
      .extend({ includeResolved: z.enum(["0", "1"]).optional() })
      .parse(req.query);
    res.json(
      listOccurrences(db, q.from, q.to, {
        accountId: q.accountId,
        includeResolved: q.includeResolved === "1",
      }),
    );
  });

  router.post("/planned", (req, res) => {
    res.status(201).json(createPlanned(db, plannedBody.parse(req.body), now()));
  });

  /** The next few dates a repeat rule would produce, for the form to show. */
  router.post("/planned/preview", (req, res) => {
    const body = previewBody.parse(req.body);
    const from = body.from ?? body.rule.startDate;
    res.json({
      dates: previewRule(
        { merchant: "preview", amountMinor: 1, direction: "out", ...body.rule },
        from,
        6,
      ),
    });
  });

  router.get("/planned/:id", (req, res) => {
    res.json(getPlanned(db, idParam.parse(req.params["id"])));
  });

  router.put("/planned/:id", (req, res) => {
    res.json(
      updatePlanned(db, idParam.parse(req.params["id"]), plannedBody.parse(req.body), now()),
    );
  });

  router.delete("/planned/:id", (req, res) => {
    deletePlanned(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  /** Skip one occurrence, mark it done, or make it expected again. */
  router.put("/planned/:id/occurrences/:date", (req, res) => {
    setOccurrenceStatus(
      db,
      idParam.parse(req.params["id"]),
      date.parse(req.params["date"]),
      statusBody.parse(req.body).status === "expected"
        ? null
        : (statusBody.parse(req.body).status as "skipped" | "done"),
      now(),
    );
    res.status(204).end();
  });

  /** Change one occurrence only: another day and/or amount; the series stays. */
  router.put("/planned/:id/occurrences/:date/change", (req, res) => {
    const body = z
      .object({ moveTo: date, amountMinor: z.number().int().min(1).max(100_000_000_000) })
      .strict()
      .parse(req.body);
    res.json(
      changeOccurrence(
        db,
        idParam.parse(req.params["id"]),
        date.parse(req.params["date"]),
        body,
        now(),
      ),
    );
  });

  /** Turn one occurrence into a real transaction on an account kept by hand. */
  router.post("/planned/:id/occurrences/:date/record", (req, res) => {
    res
      .status(201)
      .json(
        recordOccurrence(
          db,
          idParam.parse(req.params["id"]),
          date.parse(req.params["date"]),
          now(),
        ),
      );
  });

  return router;
}
