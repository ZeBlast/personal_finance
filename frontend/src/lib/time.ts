/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "2026-09-01" as a readable local date without any time-zone shifting. */
export function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "FOOD_AND_DRINK_GROCERIES" (primary "FOOD_AND_DRINK") becomes "Groceries". */
export function categoryLabel(primary: string | null, detailed: string | null): string {
  const raw =
    detailed && primary && detailed.startsWith(`${primary}_`)
      ? detailed.slice(primary.length + 1)
      : (detailed ?? primary);
  if (!raw) return "Uncategorized";
  return raw
    .toLowerCase()
    .split("_")
    .map((word) => (word === "and" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
