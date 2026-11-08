import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { useApi } from "../hooks/useApi";
import { formatMinor, parseMoneyToMinor } from "../lib/money";
import { affordSentence } from "../lib/planTools";
import { announceDataChanged } from "../lib/syncEvents";
import { today } from "../lib/period";
import { formatDay } from "../lib/time";
import { toast } from "../lib/toast";
import type { Settings } from "../types/api";
import type { AffordAnswer } from "../types/planTools";
import { defineWidget } from "./types";

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900";

export default defineWidget({
  id: "afford",
  title: "Can I afford it?",
  description:
    "Type an amount: the earliest day it keeps your cash above your goals and a buffer, or how to save for it.",
  group: "Tools",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 5 },
  defaultEnabled: false,
  order: 170,
  defaultConfig: { buffer: 0 },
  configFields: [
    { key: "buffer", label: "Buffer to keep (dollars)", type: "number", min: 0, max: 1_000_000 },
  ],
  Component: function AffordWidget({ config }) {
    const settings = useApi<Settings>("/settings");
    const currency = settings.data?.currency ?? "USD";
    const money = (n: number) => formatMinor(n, currency);
    const [amount, setAmount] = useState("");
    const [what, setWhat] = useState("");
    const [date, setDate] = useState("");
    const [answer, setAnswer] = useState<AffordAnswer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function ask(e: FormEvent): Promise<void> {
      e.preventDefault();
      const minor = parseMoneyToMinor(amount, currency);
      if (minor === null) {
        setError("Type an amount, such as 450 or 1,200.50.");
        return;
      }
      setBusy(true);
      setError(null);
      const params = new URLSearchParams({
        amountMinor: String(minor),
        bufferMinor: String(Math.round(Number(config.buffer) * 100)),
      });
      if (date) params.set("date", date);
      try {
        setAnswer(await api<AffordAnswer>(`/afford?${params.toString()}`));
      } catch (err) {
        setAnswer(null);
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }

    async function makeGoal(plan: AffordAnswer["plans"][number]): Promise<void> {
      if (!answer) return;
      try {
        await api("/goals", {
          method: "POST",
          body: JSON.stringify({
            name: what.trim() || "A purchase",
            targetMinor: answer.amountMinor,
            targetDate: plan.by,
          }),
        });
        announceDataChanged();
        toast(`Goal added: ${money(plan.perMonthMinor)} a month until ${formatDay(plan.by)}.`);
      } catch (err) {
        toast(errorMessage(err), { kind: "error" });
      }
    }

    const said = answer ? affordSentence(answer, money) : null;
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto">
        <form onSubmit={(e) => void ask(e)} className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-xs text-slate-500 dark:text-slate-400">
            What is it? (optional)
            <input
              className={inputClass}
              value={what}
              maxLength={60}
              onChange={(e) => setWhat(e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            How much
            <input
              className={inputClass}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            On (optional)
            <input
              className={inputClass}
              type="date"
              min={today()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="col-span-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Check
          </button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {answer && said && (
          <div aria-live="polite" className="space-y-1">
            <p
              className={`font-semibold ${
                said.ok
                  ? "text-green-700 dark:text-green-400"
                  : "text-slate-800 dark:text-slate-100"
              }`}
            >
              {said.headline}
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{said.detail}</p>
            {!said.ok && (
              <ul className="space-y-1 pt-1">
                {answer.plans.map((p) => (
                  <li key={p.months} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {money(p.perMonthMinor)} a month for {p.months} months
                    </span>
                    <button
                      type="button"
                      onClick={() => void makeGoal(p)}
                      className="shrink-0 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                    >
                      Make it a goal
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  },
});
