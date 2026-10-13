/**
 * A note that could not be saved is kept in this browser until it is, so changing day or closing
 * the box never loses what was typed. Storage can be unavailable (private windows); then nothing
 * is kept, and the note box still says the save failed.
 */
const key = (day: string): string => `pf.calendar.noteDraft.${day}`;

export function readDraft(day: string): string | null {
  try {
    return localStorage.getItem(key(day));
  } catch {
    return null;
  }
}

export function keepDraft(day: string, text: string): void {
  try {
    localStorage.setItem(key(day), text);
  } catch {
    // Nothing to keep it in.
  }
}

export function clearDraft(day: string): void {
  try {
    localStorage.removeItem(key(day));
  } catch {
    // Nothing kept.
  }
}
