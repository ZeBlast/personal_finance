import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { insideTauri } from "../api/client";

/**
 * Desktop notifications. In the app window they are Windows notifications (Tauri's plugin); in a
 * browser tab, the browser's own, when allowed. Returns false when they cannot be shown.
 */
export async function notificationsAllowed(ask: boolean): Promise<boolean> {
  try {
    if (insideTauri) {
      if (await isPermissionGranted()) return true;
      return ask ? (await requestPermission()) === "granted" : false;
    }
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    return ask && Notification.permission !== "denied"
      ? (await Notification.requestPermission()) === "granted"
      : false;
  } catch {
    return false;
  }
}

export async function notify(title: string, body: string): Promise<boolean> {
  if (!(await notificationsAllowed(false))) return false;
  try {
    if (insideTauri) sendNotification({ title, body });
    else new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** Remembers which reminders were already shown, so each occasion is shown once. Pure. */
export function unseen<T extends { id: string }>(
  reminders: readonly T[],
  seen: readonly string[],
): T[] {
  const already = new Set(seen);
  return reminders.filter((r) => !already.has(r.id));
}

/** The remembered list, newest last, kept short. Pure. */
export function rememberSeen(
  seen: readonly string[],
  shown: readonly string[],
  keep = 300,
): string[] {
  return [...seen, ...shown].slice(-keep);
}
