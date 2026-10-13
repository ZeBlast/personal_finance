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
