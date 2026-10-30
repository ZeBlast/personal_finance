import { useState } from "react";
import { notificationsAllowed, notify } from "../../lib/notify";
import type { Settings } from "../../types/api";

type Reminders = Settings["reminders"];

const CHOICES: Array<{ key: keyof Reminders; label: string; help: string }> = [
  {
    key: "bills",
    label: "Payments due soon",
    help: "Card payments, bills and other regular charges due in the next 3 days.",
  },
  {
    key: "signIn",
    label: "A bank needs you to sign in again",
    help: "Its balances and transactions stop updating until you reconnect it.",
  },
  {
    key: "budgets",
    label: "A budget is nearly used up",
    help: "At 90% of the month's budget, and again when it is used up.",
  },
];

/**
 * Settings: which desktop notifications to show. Each is off until turned on; turning the first
 * one on asks Windows (or the browser) for permission to show notifications.
 */
export function RemindersSettings({
  reminders,
  disabled,
  onSave,
}: {
  reminders: Reminders;
  disabled: boolean;
  onSave: (reminders: Reminders) => Promise<void>;
}) {
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(key: keyof Reminders, on: boolean): Promise<void> {
    setMessage(null);
    if (on && !(await notificationsAllowed(true))) {
      setMessage(
        "Notifications are turned off for this app. Allow them in Windows Settings > System > Notifications, then try again.",
      );
      return;
    }
    await onSave({ ...reminders, [key]: on });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-medium">Reminders</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Desktop notifications while the app is open, checked after it starts and after each sync.
        Each one is shown once.
      </p>
      {CHOICES.map((c) => (
        <label key={c.key} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={reminders[c.key]}
            disabled={disabled}
            onChange={(e) => void toggle(c.key, e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">{c.label}</span>
            <span className="block text-slate-500 dark:text-slate-400">{c.help}</span>
          </span>
        </label>
      ))}
      <button
        type="button"
        onClick={() =>
          void notify("Reminders are working", "This is how a reminder will look.").then((ok) =>
            setMessage(ok ? null : "Notifications are not allowed for this app yet."),
          )
        }
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
      >
        Send a test reminder
      </button>
      {message && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}
