import { useState, type FormEvent } from "react";
import { parseMoneyToMinor } from "../../lib/money";
import type { ScenarioAdjustment } from "../../types/planning";
import { inputClass, primaryClass, buttonClass } from "../common/styles";

export type OneOffAdjustment = Extract<ScenarioAdjustment, { kind: "one_off" }>;

/**
 * One hypothetical amount on one day: how much, going out or coming in, and an optional label. The
 * day is fixed (clicked on the chart) unless `dates` gives a range to pick from.
 */
export function WhatIfForm({
  currency,
  date,
  dates,
  onAdd,
  onCancel,
}: {
  currency: string;
  /** The day, when it was already chosen. */
  date?: string;
  /** Else the days to pick from (first and last). */
  dates?: { min: string; max: string };
  onAdd: (a: OneOffAdjustment) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState(dates?.min ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const minor = parseMoneyToMinor(amount, currency);
    const day = date ?? picked;
    if (minor === null) return setProblem("Enter an amount above zero.");
    if (!day || (dates && (day < dates.min || day > dates.max)))
      return setProblem("Pick a day in the forecast, after today.");
    onAdd({
      kind: "one_off",
      label: label.trim() || "What-if",
      date: day,
      amountMinor: direction === "out" ? -minor : minor,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <label className="block">
        Amount
        <input
          autoFocus
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={inputClass}
        />
      </label>
      <fieldset className="flex gap-4">
        <legend className="sr-only">Direction</legend>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="what-if-direction"
            checked={direction === "out"}
            onChange={() => setDirection("out")}
          />
          Going out
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="what-if-direction"
            checked={direction === "in"}
            onChange={() => setDirection("in")}
          />
          Coming in
        </label>
      </fieldset>
      <label className="block">
        Label (optional)
        <input
          value={label}
          maxLength={80}
          placeholder="What-if"
          onChange={(e) => setLabel(e.target.value)}
          className={inputClass}
        />
      </label>
      {dates && (
        <label className="block">
          Day
          <input
            type="date"
            value={picked}
            min={dates.min}
            max={dates.max}
            onChange={(e) => setPicked(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      {problem && (
        <p role="alert" className="text-xs text-red-600">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={buttonClass}>
          Cancel
        </button>
        <button type="submit" className={primaryClass}>
          Add
        </button>
      </div>
    </form>
  );
}
