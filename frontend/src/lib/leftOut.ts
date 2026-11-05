import { formatDay } from "./time";

/** Names the accounts a baseline leaves out, such as "Leaves out Old Visa, not updated since Mar 3, 2026." Pure. */
export function leftOutNote(leftOut: Array<{ name: string; through: string }> | undefined): string {
  if (!leftOut || leftOut.length === 0) return "";
  const parts = leftOut.map((a) => `${a.name}, not updated since ${formatDay(a.through)}`);
  return `Leaves out ${parts.join("; ")}.`;
}
