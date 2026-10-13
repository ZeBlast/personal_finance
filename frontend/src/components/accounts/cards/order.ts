/**
 * The user's own order of things (banks, cards), kept as a list of keys. Things not in the list
 * (new ones) keep their natural order after those that are.
 */
export function applyOrder<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(keyOf(item)) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r;
      if (a.r !== undefined) return -1;
      if (b.r !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.item);
}

/**
 * Groups laid out in rows, as the user arranged them: `rows` is the saved arrangement, `keys` the
 * groups there are now. Groups that no longer exist are dropped (and rows left empty), a group
 * listed twice keeps its first place, and new groups join the last row.
 */
export function normalizeRows(rows: string[][], keys: string[]): string[][] {
  const known = new Set(keys);
  const seen = new Set<string>();
  const out = rows
    .map((row) =>
      row.filter((k) => {
        if (!known.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    )
    .filter((row) => row.length > 0);
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    if (out.length === 0) out.push([]);
    out[out.length - 1]!.push(...missing);
  }
  return out;
}

/** Takes `key` out of the rows (dropping a row it leaves empty). */
function without(rows: string[][], key: string): string[][] {
  return rows.map((row) => row.filter((k) => k !== key)).filter((row) => row.length > 0);
}

/**
 * Puts `key` beside `target`, before or after it, in target's row. Returns the rows unchanged when
 * dropped on itself.
 */
export function moveBeside(
  rows: string[][],
  key: string,
  target: string,
  side: "before" | "after",
): string[][] {
  if (key === target) return rows;
  const next = without(rows, key);
  const r = next.findIndex((row) => row.includes(target));
  if (r < 0) return rows;
  const at = next[r]!.indexOf(target) + (side === "after" ? 1 : 0);
  next[r] = [...next[r]!.slice(0, at), key, ...next[r]!.slice(at)];
  return next;
}

/**
 * Puts `key` on a line of its own at line `index` of the current rows (0 is above the first, the
 * number of rows is below the last).
 */
export function moveToNewRow(rows: string[][], key: string, index: number): string[][] {
  // Count the place among the rows as they are, then take the key out.
  const marked = rows.map((row, i) => ({ row, i }));
  const before = marked.slice(0, index).map((m) => m.row);
  const after = marked.slice(index).map((m) => m.row);
  const strip = (list: string[][]) => without(list, key);
  return [...strip(before), [key], ...strip(after)];
}

/** `keys` with `moving` taken out and put just before `target` (or at the end if after it). */
export function moveBefore(keys: string[], moving: string, target: string): string[] {
  if (moving === target || !keys.includes(moving) || !keys.includes(target)) return keys;
  const from = keys.indexOf(moving);
  const to = keys.indexOf(target);
  const rest = keys.filter((k) => k !== moving);
  // Dragged forward, it lands after the target; dragged back, before it.
  const at = rest.indexOf(target) + (from < to ? 1 : 0);
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}
