import type { GeocodeStatus } from "../types/places";

/** The backend's pace: one address every two seconds at most (Nominatim's usage policy). */
export const SECONDS_PER_LOOKUP = 2;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function timeLeft(seconds: number): string {
  if (seconds < 90)
    return `About ${plural(Math.max(1, Math.round(seconds)), "second", "seconds")} left.`;
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
    const percent = s.total === 0 ? 0 : Math.round((s.done / s.total) * 100);
    return {
      percent,
      text: `Looked up ${s.done} of ${plural(s.total, "address", "addresses")}: ${s.found} found, ${s.notFound} not found.`,
      eta: timeLeft((s.total - s.done) * SECONDS_PER_LOOKUP),
      tone: "info",
    };
  }
  if (s.stopped !== null) {
    return {
      percent: null,
      text: `${s.message ?? "Stopped."} ${s.done} of ${s.total} were looked up.`,
      eta: null,
      tone: s.stopped === "refused" || s.stopped === "failed" ? "warn" : "info",
    };
  }
  if (s.total > 0 && s.done === s.total && s.pending === 0) {
    return {
      percent: null,
      text: `Done: ${s.found} of ${plural(s.total, "address", "addresses")} found on the map.`,
      eta: null,
      tone: "info",
    };
  }
  return {
    percent: null,
    text:
      s.pending === 0
        ? "Every address with a street has been looked up."
        : `${plural(s.pending, "address", "addresses")} came without a map position and can be looked up.`,
    eta: null,
    tone: "info",
  };
}
