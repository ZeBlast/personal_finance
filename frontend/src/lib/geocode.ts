import type { GeocodeStatus } from "../types/places";
import { formatDay } from "./time";

/** The backend's pace: one lookup every two seconds at most (Nominatim's usage policy). */
export const SECONDS_PER_LOOKUP = 2;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function timeLeft(seconds: number): string {
  if (seconds < 90) {
    return `About ${plural(Math.max(1, Math.round(seconds)), "second", "seconds")} left.`;
  }
  return `About ${plural(Math.round(seconds / 60), "minute", "minutes")} left.`;
}

/** Address lookups in words, with a percentage while a run is going. Pure. */
export function lookupProgress(s: GeocodeStatus): {
  percent: number | null;
  text: string;
  eta: string | null;
  tone: "info" | "warn";
} {
  if (s.running) {
    return {
      percent: s.total === 0 ? 0 : Math.round((s.done / s.total) * 100),
      text: `Made ${s.done} of ${plural(s.total, "lookup", "lookups")}: ${s.found} found a position, ${s.notFound} found nothing.`,
      eta: timeLeft((s.total - s.done) * SECONDS_PER_LOOKUP),
      tone: "info",
    };
  }
  if (s.stopped !== null) {
    return {
      percent: null,
      text: `${s.message ?? "Stopped."} ${s.done} of ${plural(s.total, "lookup was", "lookups were")} made.`,
      eta: null,
      tone: s.stopped === "refused" || s.stopped === "failed" ? "warn" : "info",
    };
  }
  if (s.total > 0 && s.done === s.total && s.pending === 0) {
    return {
      percent: null,
      text: `Done: ${s.found} of ${plural(s.total, "lookup", "lookups")} found a position.`,
      eta: null,
      tone: "info",
    };
  }
  return {
    percent: null,
    text:
      s.unplaced === 0
        ? "Every purchase with location details has been looked up."
        : `${plural(s.unplaced, "purchase has", "purchases have")} location details but no map position yet.`,
    eta: null,
    tone: "info",
  };
}

/** When "look up all again" can next be used, in words, or null when it can be now. Pure. */
export function resetNote(s: GeocodeStatus): string | null {
  return s.resetAvailableAt === null
    ? null
    : `Available again on ${formatDay(s.resetAvailableAt.slice(0, 10))}.`;
}
