import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useDateBasis } from "../../hooks/useDateBasis";
import { useApi } from "../../hooks/useApi";
import { useInstitutions, type Institution } from "../../hooks/useInstitutions";
import { formatMinor } from "../../lib/money";
import { firstOfMonth, lastOfMonth, monthOf, shiftMonth, today } from "../../lib/period";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { CalendarDay, CalendarMonth } from "../../types/analytics";
import type { CalendarForecast, CalendarOverlay } from "../../types/calendar";
import {
  fullMonthGrid,
  inSpan,
  isSingleDay,
  joinMonth,
  MONTH_NAMES,
  orderSpan,
  splitMonth,
  sameDayIn,
  stepDay,
  weekdayOf,
  weekOf,
  yearChoices,
  type DaySpan,
} from "./range";
import { Select } from "../common/Select";
import { showsSource, type CalendarFilters } from "./filters";
import { MonthOverview } from "./MonthOverview";
import { clearDraft, keepDraft, readDraft } from "./noteDrafts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** How far the wheel must turn before the month changes, and the pause before it can again. */

const selectClass =
  "rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-semibold hover:border-slate-300 focus:border-blue-500 dark:hover:border-slate-600 [&>option]:text-sm [&>option]:font-normal";
const navButton =
  "rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800";

/** Whole dollars when there are no cents, so the small boxes stay readable. */
function money(minor: number): string {
  const text = formatMinor(minor, "USD");
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

function cellLabel(
  date: string,
  day: CalendarDay | undefined,
  note: string | undefined,
  expected: DayExpected | undefined,
): string {
  const parts = [
    day
      ? `${day.count} transaction${day.count === 1 ? "" : "s"}, ${formatMinor(day.outflowMinor, "USD")} out, ${formatMinor(day.inflowMinor, "USD")} in`
      : "no transactions",
  ];
  if (day && day.debtPaidMinor > 0) {
    parts.push(`${formatMinor(day.debtPaidMinor, "USD")} paid toward debt`);
  }
  if (expected && expected.count > 0) {
    const named = expected.items
      .map(
        (i) =>
          `${i.merchant} ${i.direction === "in" ? "+" : "−"}${formatMinor(i.amountMinor, "USD")}`,
      )
      .join(", ");
    parts.push(
      `${expected.count} expected: ${named}${expected.count > expected.items.length ? ", and more" : ""}`,
    );
  }
  if (note) parts.push(`note: ${note}`);
  return `${formatDay(date)}, ${parts.join(", ")}`;
}

/** The days, notes, and expected transactions of a month and the months either side of it. */
function useMonths(month: string, accountId: string, basis: string) {
  const query = accountId ? `&accountId=${accountId}` : "";
  const months = [shiftMonth(month, -1), month, shiftMonth(month, 1)] as const;
  const d0 = useApi<CalendarMonth>(
    `/analytics/calendar?month=${months[0]}${query}&dateBasis=${basis}`,
  );
  const d1 = useApi<CalendarMonth>(
    `/analytics/calendar?month=${months[1]}${query}&dateBasis=${basis}`,
  );
  const d2 = useApi<CalendarMonth>(
    `/analytics/calendar?month=${months[2]}${query}&dateBasis=${basis}`,
  );
  const o0 = useApi<CalendarOverlay>(`/calendar/overlay?month=${months[0]}${query}`);
  const o1 = useApi<CalendarOverlay>(`/calendar/overlay?month=${months[1]}${query}`);
  const o2 = useApi<CalendarOverlay>(`/calendar/overlay?month=${months[2]}${query}`);
  const days = useMemo(
    () =>
      new Map(
        [d0.data, d1.data, d2.data].flatMap((m) => m?.days ?? []).map((d) => [d.date, d] as const),
      ),
    [d0.data, d1.data, d2.data],
  );
  const notes = useMemo(
    () => ({ ...o0.data?.notes, ...o1.data?.notes, ...o2.data?.notes }) as Record<string, string>,
    [o0.data, o1.data, o2.data],
  );
  const expected = useMemo(
    () =>
      new Map(
        [o0.data, o1.data, o2.data]
          .flatMap((o) => o?.expected ?? [])
          .map((e) => [e.date, e] as const),
      ),
    [o0.data, o1.data, o2.data],
  );
  return {
    days,
    notes,
    expected,
    loading: d1.loading || o1.loading,
    refreshing: [d0, d1, d2, o0, o1, o2].some((r) => r.refreshing),
    /** Months (of the three shown) whose days or notes could not be loaded. */
    failed: new Set(
      months.filter((_, i) => [d0, d1, d2][i]!.error !== null || [o0, o1, o2][i]!.error !== null),
    ),
    error: d1.error ?? o1.error ?? d0.error ?? d2.error ?? o0.error ?? o2.error,
    retry: () => [d0, d1, d2, o0, o1, o2].forEach((r) => r.reload()),
    reloadNotes: () => {
      o0.reload();
      o1.reload();
      o2.reload();
    },
  };
}

/**
 * The big month calendar. Click a day to look at it; press on one day and drag to another (or
 * Shift+click) to look at everything from one day to the other. The arrows, the month and year
 * pickers and Today change the month; a single chosen day moves along to the same day of the new
 * month. With one day chosen, click the empty space in its box to write a note.
 *
 * From the keyboard the month is one grid with one stop on Tab: the arrows move between days,
 * Shift+arrows stretch the chosen span, Home and End go to the week's ends, Page Up and Page Down
 * change the month (with Shift, the year), Enter or Space chooses, and Escape clears.
 */
export function CalendarBoard({
  accountId,
  accountName,
  filters,
  lowCash,
  selection,
  onSelect,
}: {
  accountId: string;
  accountName: string | null;
  filters: CalendarFilters;
  /** Projected cash below this (cents) marks a day. */
  lowCash: number;
  selection: DaySpan | null;
  onSelect: (span: DaySpan | null) => void;
}) {
  const todayDay = today();
  const [month, setMonthState] = useState(() => monthOf(selection?.from ?? todayDay));
  const [direction, setDirection] = useState<"next" | "prev" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** The day that takes the keyboard focus: the only day reached with Tab. */
  const [active, setActive] = useState(selection?.from ?? todayDay);
  // The day a drag or a Shift+click extends from.
  const anchor = useRef<string | null>(selection?.from ?? null);
  const moved = useRef(false);
  const toggleOff = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);

  const basis = useDateBasis();
  const institutions = useInstitutions();
  const data = useMonths(month, accountId, basis);
  const weeks = useMemo(() => fullMonthGrid(month), [month]);
  // The cash forecast covers all bank accounts, so it is shown only for all accounts.
  const gridFrom = weeks[0]![0]!.date;
  const gridTo = weeks.at(-1)!.at(-1)!.date;
  const forecast = useApi<CalendarForecast>(
    filters.forecast && !accountId ? `/calendar/forecast?from=${gridFrom}&to=${gridTo}` : null,
  );
  // A month that failed to load matters only when some of its days are on screen.
  const failedShown = weeks.flat().some((c) => data.failed.has(monthOf(c.date)));
  const forecastDays = useMemo(
    () => new Map((forecast.data?.days ?? []).map((d) => [d.date, d] as const)),
    [forecast.data],
  );
  const { year, monthIndex } = splitMonth(month);
  const thisYear = Number(todayDay.slice(0, 4));
  // The day Tab reaches: the active one when it is shown, otherwise the month's first.
  const tabbable = weeks.flat().some((c) => c.date === active) ? active : `${month}-01`;

  function setMonth(next: string): void {
    if (next === month) return;
    setDirection(next > month ? "next" : "prev");
    setEditing(null);
    setMonthState(next);
  }
  /**
   * A month chosen on purpose (arrows, pickers): a single chosen day moves to the same day of that
   * month, so the panel always matches the grid. A span is kept, and the panel names it in full.
   */
  function navigate(next: string): void {
    setMonth(next);
    if (selection && isSingleDay(selection) && monthOf(selection.from) !== next) {
      const day = sameDayIn(next, selection.from);
      anchor.current = day;
      setActive(day);
      onSelect({ from: day, to: day });
    }
  }
  const go = (delta: number): void => navigate(shiftMonth(month, delta));

  /** Puts the keyboard focus on a day, turning to its month first. */
  function focusDay(day: string): void {
    setActive(day);
    if (monthOf(day) !== month) setMonth(monthOf(day));
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLElement>(`[data-date="${day}"]`)?.focus(),
    );
  }

  /** Chooses a span (or day) around today and shows it. */
  function chooseAround(span: DaySpan): void {
    setMonth(monthOf(todayDay));
    anchor.current = span.from;
    onSelect(span);
    focusDay(todayDay);
  }

  // A day chosen from elsewhere (the panel's list of notes) becomes the one Tab reaches.
  useEffect(() => {
    if (selection) setActive(selection.from);
  }, [selection]);

  // Releasing the mouse anywhere ends a drag.
  useEffect(() => {
    if (!dragging) return;
    const stop = (): void => {
      setDragging(false);
      // A press and release on the same, already chosen day chooses nothing.
      if (!moved.current && toggleOff.current) onSelect(null);
      toggleOff.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, onSelect]);

  function press(e: PointerEvent<HTMLDivElement>, date: string): void {
    if (e.button !== 0) return;
    // Touch screens keep sending events to the pressed cell unless that is released.
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    moved.current = false;
    setEditing(null);
    if (e.shiftKey && anchor.current) {
      onSelect(orderSpan(anchor.current, date));
      return;
    }
    toggleOff.current = selection !== null && isSingleDay(selection) && selection.from === date;
    anchor.current = date;
    setDragging(true);
    onSelect({ from: date, to: date });
  }

  function enter(date: string): void {
    if (!dragging || anchor.current === null) return;
    if (date !== anchor.current) moved.current = true;
    onSelect(orderSpan(anchor.current, date));
  }

  function keys(e: KeyboardEvent<HTMLDivElement>, date: string): void {
    if (e.target !== e.currentTarget) return; // typing in the note box
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.shiftKey && anchor.current) onSelect(orderSpan(anchor.current, date));
      else {
        anchor.current = date;
        onSelect({ from: date, to: date });
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onSelect(null);
      return;
    }
    const arrow = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const back = weekdayOf(date);
    const next =
      arrow !== undefined
        ? stepDay(date, arrow)
        : e.key === "Home"
          ? stepDay(date, -back)
          : e.key === "End"
            ? stepDay(date, 6 - back)
            : e.key === "PageUp" || e.key === "PageDown"
              ? sameDayIn(
                  shiftMonth(monthOf(date), (e.key === "PageUp" ? -1 : 1) * (e.shiftKey ? 12 : 1)),
                  date,
                )
              : null;
    if (next === null) return;
    e.preventDefault();
    // Shift+arrow stretches the chosen span from where it started to the new day.
    if (e.shiftKey && arrow !== undefined) {
      const from = anchor.current ?? date;
      anchor.current = from;
      onSelect(orderSpan(from, next));
    }
    focusDay(next);
  }

  return (
    <div ref={area} className="flex h-full min-h-0 flex-col" data-keep-selection>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => go(-1)}
            className={navButton}
          >
            ‹
          </button>
          <Select
            aria-label="Month"
            value={monthIndex}
            onChange={(e) => navigate(joinMonth(year, Number(e.target.value)))}
            className={selectClass}
          >
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Year"
            value={year}
            onChange={(e) => navigate(joinMonth(Number(e.target.value), monthIndex))}
            className={selectClass}
          >
            {yearChoices(year, thisYear).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
          <button type="button" aria-label="Next month" onClick={() => go(1)} className={navButton}>
            ›
          </button>
        </div>
        <div className="flex items-center gap-2">
          {data.loading && <span className="text-xs text-slate-500">Loading...</span>}
          {data.refreshing && (
            <span className="text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
              Refreshing...
            </span>
          )}
          <button
            type="button"
            onClick={() => chooseAround({ from: todayDay, to: todayDay })}
            className={navButton}
            title="Show this month and choose today"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => chooseAround(weekOf(todayDay))}
            className={navButton}
            title="Choose this week, Sunday to Saturday"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() =>
              chooseAround({
                from: firstOfMonth(monthOf(todayDay)),
                to: lastOfMonth(monthOf(todayDay)),
              })
            }
            className={navButton}
            title="Choose this whole month"
          >
            This month
          </button>
        </div>
      </div>

      <MonthOverview month={month} accountId={accountId} accountName={accountName} />
      {!data.loading &&
        !data.failed.has(month) &&
        ![...data.days.values()].some((d) => monthOf(d.date) === month && d.count > 0) &&
        ![...data.expected.keys()].some((d) => monthOf(d) === month) && (
          <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
            Nothing recorded or expected in {MONTH_NAMES[monthIndex]} {year}
            {accountName ? ` for ${accountName}` : ""}. Add an expected transaction from a day, or
            sync your accounts to bring in their history.
          </p>
        )}

      {failedShown && (
        <p role="alert" className="mb-1 text-sm text-red-600">
          Some days could not be loaded and are marked &ldquo;not loaded&rdquo; (not empty):{" "}
          {data.error}{" "}
          <button type="button" className="underline" onClick={data.retry}>
            Try again
          </button>
        </p>
      )}

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500" aria-hidden="true">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-hidden">
        <div
          key={month}
          ref={grid}
          role="grid"
          aria-label={`${MONTH_NAMES[monthIndex]} ${year}`}
          aria-multiselectable="true"
          className={`grid h-full grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 select-none dark:border-slate-700 dark:bg-slate-700 ${
            direction === "next" ? "pf-month-next" : direction === "prev" ? "pf-month-prev" : ""
          }`}
          style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.map((week) => (
            <div key={week[0]!.date} role="row" className="contents">
              {week.map(({ date, inMonth }) => (
                <DayCell
                  key={date}
                  date={date}
                  inMonth={inMonth}
                  isToday={date === todayDay}
                  day={filters.recorded ? data.days.get(date) : undefined}
                  pendingCount={filters.pending ? (data.days.get(date)?.pendingCount ?? 0) : 0}
                  unavailable={data.failed.has(monthOf(date))}
                  note={data.notes[date]}
                  expected={visibleExpected(data.expected.get(date), filters)}
                  forecast={forecastDays.get(date)}
                  lowCash={lowCash}
                  inside={inSpan(date, selection)}
                  isEdge={selection !== null && (date === selection.from || date === selection.to)}
                  editing={editing === date}
                  institutions={institutions}
                  tabbable={date === tabbable}
                  onFocus={() => setActive(date)}
                  onPress={(e) => press(e, date)}
                  onEnter={() => enter(date)}
                  onKeyDown={(e) => keys(e, date)}
                  chosen={selection !== null && isSingleDay(selection) && selection.from === date}
                  onEditNote={() => setEditing(date)}
                  onDoneEditing={(saved) => {
                    setEditing(null);
                    if (saved) {
                      data.reloadNotes();
                      announceDataChanged();
                    }
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Click a day, or press on one day and drag to another (or Shift+click), to total up the days
        in between. With the keyboard: arrows move, Shift+arrows stretch the span, Page Up and Page
        Down change month, Escape clears. Click a chosen day's note box to write in it; press Enter
        or click away to save. Dots on the left are the kinds of transactions that day (by
        category); logos on the right are the banks involved. ↻ marks an expected transaction, ● a
        pending one.
      </p>
    </div>
  );
}

const MAX_DOTS = 6;
const MAX_LOGOS = 3;

function DayCell({
  date,
  inMonth,
  isToday,
  day,
  pendingCount,
  unavailable,
  note,
  expected,
  forecast,
  lowCash,
  inside,
  isEdge,
  editing,
  institutions,
  tabbable,
  onFocus,
  onPress,
  onEnter,
  onKeyDown,
  chosen,
  onEditNote,
  onDoneEditing,
}: {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  day: CalendarDay | undefined;
  /** Pending transactions that day (0 when pending ones are hidden). */
  pendingCount: number;
  /** The day's month could not be loaded: say so rather than look empty. */
  unavailable: boolean;
  note: string | undefined;
  expected: DayExpected | undefined;
  /** The cash forecast for the day, when it is ahead and the forecast is shown. */
  forecast: ForecastDay | undefined;
  lowCash: number;
  inside: boolean;
  isEdge: boolean;
  editing: boolean;
  institutions: Map<number, Institution>;
  /** The one day reached with Tab. */
  tabbable: boolean;
  onFocus: () => void;
  onPress: (e: PointerEvent<HTMLDivElement>) => void;
  onEnter: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** The only day chosen: its note box shows, and clicking the box edits the note. */
  chosen: boolean;
  onEditNote: () => void;
  onDoneEditing: (saved: boolean) => void;
}) {
  const pressedWhileChosen = useRef(false);
  const expectedCount = expected?.count ?? 0;
  const low = forecast !== undefined && forecast.cashMinor < lowCash;
  // The banks involved that day, once each; accounts kept by hand share one "by hand" mark.
  const banks = useMemo(() => {
    const seen = new Map<
      string,
      { key: string; name: string; logo: string | null; color: string | null }
    >();
    for (const a of day?.accounts ?? []) {
      const inst = a.itemId !== null ? institutions.get(a.itemId) : undefined;
      const key = a.itemId === null ? "manual" : `item-${a.itemId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        key,
        name: inst?.institutionName ?? a.institutionName ?? "Kept by hand",
        logo: inst?.logo ?? null,
        color: inst?.color ?? (a.itemId === null ? "#64748b" : null),
      });
    }
    return [...seen.values()];
  }, [day, institutions]);

  return (
    <div
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-date={date}
      aria-label={
        (unavailable ? `${formatDay(date)}, not loaded` : cellLabel(date, day, note, expected)) +
        (forecast
          ? `, projected cash ${formatMinor(forecast.cashMinor, "USD")}${low ? ", below your warning level" : ""}`
          : "")
      }
      aria-selected={inside}
      aria-current={isToday ? "date" : undefined}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus();
      }}
      onPointerDown={onPress}
      onPointerEnter={onEnter}
      onKeyDown={onKeyDown}
      // While its note is being written, the box must not take focus from the note (that closes it).
      onMouseDown={(e) => {
        if (editing) e.preventDefault();
      }}
      className={`relative flex min-h-0 touch-none flex-col gap-0.5 overflow-hidden px-1 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset ${
        inside
          ? isEdge
            ? "bg-blue-100 dark:bg-blue-900"
            : "bg-blue-50 dark:bg-blue-950"
          : inMonth
            ? "bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800"
            : "bg-slate-50 text-slate-400 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-900"
      } ${low ? "ring-2 ring-amber-500 ring-inset" : ""}`}
    >
      {/* The date, large and centred; expected and pending marks in the corners. */}
      <div className="relative flex justify-center">
        {expectedCount > 0 && (
          <span
            className="absolute top-0 left-0 text-sm font-semibold text-violet-700 dark:text-violet-300"
            title={`${expectedCount} expected`}
            aria-hidden="true"
          >
            ↻{expectedCount}
          </span>
        )}
        <span
          className={`flex h-10 w-10 items-center justify-center rounded-full text-2xl font-semibold ${
            isToday
              ? "bg-white text-slate-900 shadow ring-1 ring-slate-300"
              : "text-slate-700 dark:text-slate-200"
          }`}
        >
          {Number(date.slice(8))}
        </span>
        {pendingCount > 0 && (
          <span
            className="absolute top-0 right-0 text-sm text-amber-600"
            title={`${pendingCount} pending`}
            aria-hidden="true"
          >
            ●
          </span>
        )}
      </div>

      {unavailable && (
        <div className="text-center text-[11px] text-red-600 dark:text-red-400">Not loaded</div>
      )}
      {day && <DayTotals day={day} />}
      {expected && expected.count > 0 && <ExpectedPreview expected={expected} />}
      {forecast && <ForecastPreview forecast={forecast} low={low} />}

      {/* The note, in the middle of the box. On the chosen day there is always a box for it, and
          clicking that box writes in it. Pressing anywhere else still selects days as usual. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-0.5">
        {editing ? (
          <NoteEditor date={date} note={note ?? ""} onDone={onDoneEditing} />
        ) : note || chosen ? (
          <div
            role={chosen ? "button" : undefined}
            tabIndex={chosen ? 0 : undefined}
            onPointerDown={(e) => {
              // Whether the day was already chosen when pressed: the first click only chooses it.
              pressedWhileChosen.current = chosen;
              // On the chosen day the box is for the note, not for selecting.
              if (chosen && e.button === 0) e.stopPropagation();
            }}
            // Keep the click from moving focus to the day box, which would close the note at once.
            onMouseDown={(e) => {
              if (chosen) e.preventDefault();
            }}
            onClick={() => {
              if (chosen && pressedWhileChosen.current) onEditNote();
            }}
            onKeyDown={(e) => {
              if (chosen && e.key === "Enter") {
                e.stopPropagation();
                onEditNote();
              }
            }}
            title={chosen ? (note ? "Click to edit this note" : "Click to write a note") : note}
            className={`line-clamp-3 min-h-5 w-full rounded px-1 py-0.5 text-center text-[10px] ${
              note
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:ring-slate-600"
                : "border border-dashed border-slate-300 dark:border-slate-600"
            } ${chosen ? "cursor-text hover:border-slate-400" : ""}`}
          >
            {note}
          </div>
        ) : null}
      </div>

      {day && (
        <div className="flex items-end justify-between gap-1">
          <span className="flex flex-wrap items-center gap-0.5">
            {day.categories.slice(0, MAX_DOTS).map((c) => (
              <span
                key={c.categoryId ?? "none"}
                title={`${c.name}: ${c.count}`}
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: c.color ?? "#94a3b8" }}
              />
            ))}
            {day.categories.length > MAX_DOTS && (
              <span
                className="text-xs text-slate-500"
                title={day.categories
                  .slice(MAX_DOTS)
                  .map((c) => c.name)
                  .join(", ")}
              >
                +{day.categories.length - MAX_DOTS}
              </span>
            )}
          </span>
          <span className="flex items-center -space-x-1">
            {banks.slice(0, MAX_LOGOS).map((b) =>
              b.logo ? (
                <img
                  key={b.key}
                  src={b.logo}
                  alt={b.name}
                  title={b.name}
                  className="h-6 w-6 rounded-full bg-white object-contain ring-1 ring-white dark:ring-slate-900"
                />
              ) : (
                <span
                  key={b.key}
                  title={b.name}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-white ring-1 ring-white dark:ring-slate-900"
                  style={{ backgroundColor: b.color ?? "#475569" }}
                >
                  {b.key === "manual" ? "✋" : b.name.slice(0, 1).toUpperCase()}
                </span>
              ),
            )}
            {banks.length > MAX_LOGOS && (
              <span className="pl-1.5 text-xs text-slate-500">+{banks.length - MAX_LOGOS}</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

type DayExpected = CalendarOverlay["expected"][number];
type ForecastDay = CalendarForecast["days"][number];

/**
 * What the forecast adds to a day ahead: card bills and recurring items found in the history
 * (plans and pending entries are already named above), and the cash left in the bank accounts,
 * marked when it falls below the warning level.
 */
function ForecastPreview({ forecast, low }: { forecast: ForecastDay; low: boolean }) {
  const extra = forecast.events.filter((e) => e.source === "card_bill" || e.source === "recurring");
  return (
    <div className="flex flex-col gap-0.5" aria-hidden="true">
      {extra.slice(0, 2).map((e, n) => (
        <div
          key={n}
          title={
            e.source === "card_bill"
              ? "Card bill due (estimated)"
              : "Found recurring in your history"
          }
          className={`flex items-baseline justify-between gap-1 rounded px-1 text-[11px] leading-4 ${
            e.source === "card_bill"
              ? "border border-sky-300 bg-sky-50/70 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-200"
              : "border border-dotted border-slate-400 text-slate-700 dark:border-slate-500 dark:text-slate-300"
          }`}
        >
          <span className="truncate">{e.label}</span>
          <span className="shrink-0 tabular-nums">
            {e.amountMinor > 0 ? "+" : "−"}
            {money(Math.abs(e.amountMinor))}
          </span>
        </div>
      ))}
      <div
        className={`text-center text-[11px] leading-4 tabular-nums ${
          low
            ? "font-semibold text-amber-700 dark:text-amber-400"
            : "text-slate-500 dark:text-slate-400"
        }`}
        title="Projected cash in your bank accounts at the end of the day"
      >
        {low ? "Low cash " : "Cash "}≈ {money(forecast.cashMinor)}
      </div>
    </div>
  );
}

/** A day's expected items of the kinds shown, counted again; nothing when none is shown. */
function visibleExpected(
  e: DayExpected | undefined,
  filters: CalendarFilters,
): DayExpected | undefined {
  if (!e) return undefined;
  const items = e.items.filter((i) => showsSource(filters, i.source));
  return items.length === 0 ? undefined : { ...e, items, count: items.length };
}

/** How many expected items a day names; the rest are "+N more" (all are in the day's panel). */
const PREVIEW_ITEMS = 2;

/**
 * The day's largest expected items by name and amount ("Rent −$1,200"), dashed and violet so a
 * projection never looks like something that already happened.
 */
function ExpectedPreview({ expected }: { expected: DayExpected }) {
  const shown = expected.items.slice(0, PREVIEW_ITEMS);
  const more = expected.count - shown.length;
  return (
    <div className="flex flex-col gap-0.5" aria-hidden="true">
      {shown.map((i, n) => (
        <div
          key={n}
          title={`Expected (${i.source === "pending" ? "pending manual" : "planned"}): ${i.merchant}`}
          className="flex items-baseline justify-between gap-1 rounded border border-dashed border-violet-300 bg-violet-50/70 px-1 text-[11px] leading-4 text-violet-900 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-200"
        >
          <span className="truncate">{i.merchant}</span>
          <span className="shrink-0 tabular-nums">
            {i.direction === "in" ? "+" : "−"}
            {money(i.amountMinor)}
          </span>
        </div>
      ))}
      {more > 0 && (
        <div className="text-center text-[11px] leading-4 text-violet-700 dark:text-violet-300">
          +{more} more
        </div>
      )}
    </div>
  );
}

/** Money out, money in, and debt paid that day, as plain numbers under the date. */
function DayTotals({ day }: { day: CalendarDay }) {
  const parts = [
    day.outflowMinor > 0 && (
      <span key="out" className="text-slate-700 dark:text-slate-200">
        −{money(day.outflowMinor)}
      </span>
    ),
    day.inflowMinor > 0 && (
      <span key="in" className="text-green-700 dark:text-green-400">
        +{money(day.inflowMinor)}
      </span>
    ),
    day.debtPaidMinor > 0 && (
      <span
        key="debt"
        className="text-sky-700 dark:text-sky-400"
        title="Paid toward credit cards or loans. This lowers what you owe; it is not spending."
      >
        ↓{money(day.debtPaidMinor)}
      </span>
    ),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-1.5 text-sm leading-5 font-semibold tabular-nums"
      title="Money out · money in · paid toward debt"
    >
      {parts}
    </div>
  );
}

/**
 * A day's note being written, right in its box: no buttons. Enter or clicking away saves it (an
 * empty note is deleted); Shift+Enter starts a new line; Escape leaves it as it was.
 */
function NoteEditor({
  date,
  note,
  onDone,
}: {
  date: string;
  note: string;
  onDone: (saved: boolean) => void;
}) {
  const [text, setText] = useState(() => readDraft(date) ?? note);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(false);
  const latest = useRef(text);
  latest.current = text;

  const save = async (): Promise<void> => {
    if (finished.current) return;
    finished.current = true;
    const value = latest.current.trim();
    if (value === note.trim()) {
      onDone(false);
      return;
    }
    try {
      await api(`/calendar/notes/${date}`, {
        method: "PUT",
        body: JSON.stringify({ note: value }),
      });
      clearDraft(date);
      onDone(true);
    } catch (e) {
      keepDraft(date, value);
      finished.current = false;
      setError(errorMessage(e, "Could not save the note."));
    }
  };

  // Leaving the box any other way (choosing another day, changing month) also saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      // Only when something was typed (React may unmount and remount once while developing).
      if (!finished.current && latest.current.trim() !== note.trim()) void saveRef.current();
    },
    [],
  );

  return (
    <div onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        aria-label={`Note for ${formatDay(date)}`}
        autoFocus
        rows={2}
        maxLength={4000}
        value={text}
        // Continue where the note ends.
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            finished.current = true;
            onDone(false);
          }
        }}
        className="block w-full resize-none rounded border border-dashed border-slate-400 bg-transparent px-1 py-0.5 text-center text-[10px] outline-none dark:border-slate-500"
      />
      {error && (
        <p role="alert" className="text-[10px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
