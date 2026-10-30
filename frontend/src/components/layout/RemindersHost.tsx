import { useEffect } from "react";
import { api } from "../../api/client";
import { notify, rememberSeen, unseen } from "../../lib/notify";
import { useSyncFinishedCount } from "../../lib/syncEvents";
import type { Settings } from "../../types/api";

interface Reminder {
  id: string;
  title: string;
  body: string;
}

const SEEN_KEY = "pf.reminders.seen";

function readSeen(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Asks for due reminders and shows each new one as a desktop notification. */
export async function checkReminders(): Promise<number> {
  const settings = await api<Settings>("/settings");
  const r = settings.reminders;
  if (!r.bills && !r.signIn && !r.budgets) return 0;
  const fresh = unseen(await api<Reminder[]>("/reminders"), readSeen());
  const shown: string[] = [];
  for (const reminder of fresh) {
    if (await notify(reminder.title, reminder.body)) shown.push(reminder.id);
  }
  if (shown.length > 0) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(rememberSeen(readSeen(), shown)));
    } catch {
      // Without storage a reminder may repeat; nothing worse.
    }
  }
  return shown.length;
}

/**
 * Renders nothing. A little after the app opens, and after each sync (which brings the newest
 * balances, bills and connection problems), it checks for reminders to show.
 */
export function RemindersHost() {
  const syncs = useSyncFinishedCount();
  useEffect(() => {
    const timer = setTimeout(() => void checkReminders().catch(() => undefined), 8000);
    return () => clearTimeout(timer);
  }, [syncs]);
  return null;
}
