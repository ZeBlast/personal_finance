import { useApi } from "../../hooks/useApi";

export interface Badge {
  count: number;
  tone: "info" | "warn";
  label: string;
}

export type Badges = Record<string, Badge>;

/** What is waiting in each section (by path); reloads after syncs and edits like other data. */
export function useBadges(): Badges {
  return useApi<Badges>("/nav/badges").data ?? {};
}

/**
 * An area's badge: its sections' counts added up (the area's own path included), `warn` if any
 * section warns. Null when nothing is waiting. Pure.
 */
export function areaBadge(badges: Badges, areaPath: string): Badge | null {
  const mine = Object.entries(badges).filter(
    ([path]) => path === areaPath || path.startsWith(`${areaPath}/`),
  );
  if (mine.length === 0) return null;
  return {
    count: mine.reduce((n, [, b]) => n + b.count, 0),
    tone: mine.some(([, b]) => b.tone === "warn") ? "warn" : "info",
    label: mine.map(([, b]) => b.label).join("; "),
  };
}

/** A small count, amber when something needs doing. */
export function NavBadge({ badge, active = false }: { badge: Badge | null; active?: boolean }) {
  if (!badge) return null;
  const tone = active
    ? "bg-white/90 text-blue-700"
    : badge.tone === "warn"
      ? "bg-amber-500 text-white"
      : "bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-100";
  return (
    <span
      title={badge.label}
      aria-label={badge.label}
      className={`ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] leading-5 font-semibold tabular-nums ${tone}`}
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}
