import { and, eq, ne } from "drizzle-orm";
import { plaidItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { renewalInbox } from "./renewal.service.js";
import { duplicatePairs, reviewQueue, uncategorized } from "./review.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Counts for the navigation: what is waiting for the user in each section, so the sidebar and the
 * section tabs can show it without the page being opened.
 */

export interface Badge {
  count: number;
  /** `warn` needs doing soon; `info` is there to look at. */
  tone: "info" | "warn";
  /** What the count is, for a tooltip and screen readers. */
  label: string;
}

/** By section path (such as `/transactions/review`). Sections with nothing waiting are left out. */
export type Badges = Record<string, Badge>;

/** Renewals this many days ahead count toward the badge. */
const RENEWAL_DAYS = 7;

export function navBadges(db: AppDb, today = new Date().toISOString().slice(0, 10)): Badges {
  const out: Badges = {};

  const queue = reviewQueue(db, today).items.length;
  const unfiled = uncategorized(db).total;
  const duplicates = duplicatePairs(db, today).length;
  const review = queue + unfiled + duplicates;
  if (review > 0) {
    const parts = [
      queue > 0 && `${queue} to review`,
      unfiled > 0 && `${unfiled} uncategorized`,
      duplicates > 0 && `${duplicates} possible duplicate${duplicates === 1 ? "" : "s"}`,
    ].filter(Boolean);
    out["/transactions/review"] = { count: review, tone: "info", label: parts.join(", ") };
  }

  const soon = addDays(today, RENEWAL_DAYS);
  const renewals = renewalInbox(db, today).filter((i) => i.date <= soon).length;
  if (renewals > 0) {
    out["/planning/subscriptions"] = {
      count: renewals,
      tone: "info",
      label: `${renewals} coming up in the next ${RENEWAL_DAYS} days`,
    };
  }

  const broken = db
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(
      and(
        eq(plaidItems.environment, getSettings(db).plaidEnvironment),
        ne(plaidItems.status, "active"),
      ),
    )
    .all().length;
  if (broken > 0) {
    out["/accounts"] = {
      count: broken,
      tone: "warn",
      label: `${broken} bank connection${broken === 1 ? " needs" : "s need"} attention`,
    };
  }
  return out;
}
