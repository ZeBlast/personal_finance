/**
 * Keyboard moves on Activity: J / K (or the arrow keys) step through the rows on the page, X ticks
 * the highlighted row, Enter opens it, Escape clears the ticks.
 */
export type ActivityKey = "next" | "previous" | "tick" | "open" | "clear";

export function activityKey(key: string): ActivityKey | null {
  switch (key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "x":
      return "tick";
    case "Enter":
      return "open";
    case "Escape":
      return "clear";
    default:
      return null;
  }
}

/** The row to highlight after a step: from nothing, down starts at the top and up at the bottom. */
export function moveHighlight(
  ids: readonly number[],
  current: number | null,
  step: 1 | -1,
): number | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return step === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))]!;
}

/** Keys typed into a box, a list or an open window are theirs, not Activity's. */
export function keyBelongsElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) {
    return true;
  }
  return target.closest("[role='dialog'], [role='listbox']") !== null;
}
