import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useDateBasis } from "../../hooks/useDateBasis";
import { useApi } from "../../hooks/useApi";
import { useInstitutions, type Institution } from "../../hooks/useInstitutions";
import { formatMinor } from "../../lib/money";
import { monthOf, shiftMonth, today } from "../../lib/period";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { CalendarDay, CalendarMonth } from "../../types/analytics";
import type { CalendarOverlay } from "../../types/calendar";
import {
  fullMonthGrid,
  inSpan,
  isSingleDay,
  joinMonth,
  MONTH_NAMES,
  orderSpan,
  splitMonth,
  stepDay,
  yearChoices,
  type DaySpan,
} from "./range";
import { Select } from "../common/Select";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** How far the wheel must turn before the month changes, and the pause before it can again. */
const WHEEL_STEP = 60;
const WHEEL_PAUSE_MS = 450;

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
  expectedCount: number,
): string {
  const parts = [
    day
      ? `${day.count} transaction${day.count === 1 ? "" : "s"}, ${formatMinor(day.outflowMinor, "USD")} out, ${formatMinor(day.inflowMinor, "USD")} in`
      : "no transactions",
  ];
  if (day && day.debtPaidMinor > 0) {
    parts.push(`${formatMinor(day.debtPaidMinor, "USD")} paid toward debt`);
  }
  if (expectedCount > 0) parts.push(`${expectedCount} expected`);
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
    error: d1.error ?? o1.error,
    reloadNotes: () => {
      o0.reload();
      o1.reload();
      o2.reload();
    },
  };
}

/**
 * The big month calendar. Click a day to look at it; press on one day and drag to another (or
 * Shift+click) to look at everything from one day to the other. Turn the mouse wheel to go to the
 * next or previous month. With one day chosen, click the empty space in its box to write a note.
 */
export function CalendarBoard({
  accountId,
  selection,
  onSelect,
}: {
  accountId: string;
  selection: DaySpan | null;
  onSelect: (span: DaySpan | null) => void;
}) {
  const todayDay = today();
  const [month, setMonthState] = useState(() => monthOf(selection?.from ?? todayDay));
  const [direction, setDirection] = useState<"next" | "prev" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
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
  const { year, monthIndex } = splitMonth(month);
  const thisYear = Number(todayDay.slice(0, 4));

  function setMonth(next: string): void {
    if (next === month) return;
    setDirection(next > month ? "next" : "prev");
    setEditing(null);
    setMonthState(next);
  }
  const go = (delta: number): void => setMonth(shiftMonth(month, delta));

  // The mouse wheel turns the months. The listener is not passive so the page does not scroll too.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let total = 0;
    let pausedUntil = 0;
    const onWheel = (e: WheelEvent): void => {
      if (editing) return;
      e.preventDefault();
      const now = Date.now();
      if (now < pausedUntil) return;
      total += e.deltaY;
      if (Math.abs(total) < WHEEL_STEP) return;
      goRef.current(total > 0 ? 1 : -1);
      total = 0;
      pausedUntil = now + WHEEL_PAUSE_MS;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [editing]);

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
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = stepDay(date, delta);
    if (monthOf(next) !== month) setMonth(monthOf(next));
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus(),
    );
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
            onChange={(e) => setMonth(joinMonth(year, Number(e.target.value)))}
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
            onChange={(e) => setMonth(joinMonth(Number(e.target.value), monthIndex))}
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
          {month !== monthOf(todayDay) && (
            <button type="button" onClick={() => setMonth(monthOf(todayDay))} className={navButton}>
              Today
            </button>
          )}
        </div>
      </div>

      {data.error && (
        <p role="alert" className="text-sm text-red-600">
          {data.error}
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
          role="group"
          aria-label={`${MONTH_NAMES[monthIndex]} ${year}`}
          className={`grid h-full grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 select-none dark:border-slate-700 dark:bg-slate-700 ${
            direction === "next" ? "pf-month-next" : direction === "prev" ? "pf-month-prev" : ""
          }`}
          style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.flat().map(({ date, inMonth }) => (
            <DayCell
              key={date}
              date={date}
              inMonth={inMonth}
              isToday={date === todayDay}
              day={data.days.get(date)}
              note={data.notes[date]}
              expectedCount={data.expected.get(date)?.count ?? 0}
              inside={inSpan(date, selection)}
              isEdge={selection !== null && (date === selection.from || date === selection.to)}
              editing={editing === date}
              institutions={institutions}
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
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Click a day, or press on one day and drag to another (or Shift+click), to total up the days
        in between. Turn the mouse wheel to change month. Click a chosen day's note box to write in
        it; press Enter or click away to save. Dots on the left are the kinds of transactions that
        day (by category); logos on the right are the banks involved. ↻ marks an expected
        transaction, ● a pending one.
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
  note,
  expectedCount,
  inside,
  isEdge,
  editing,
  institutions,
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
  note: string | undefined;
  expectedCount: number;
  inside: boolean;
  isEdge: boolean;
  editing: boolean;
  institutions: Map<number, Institution>;
  onPress: (e: PointerEvent<HTMLDivElement>) => void;
  onEnter: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** The only day chosen: its note box shows, and clicking the box edits the note. */
  chosen: boolean;
  onEditNote: () => void;
  onDoneEditing: (saved: boolean) => void;
}) {
  const pressedWhileChosen = useRef(false);
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
      role="button"
      tabIndex={0}
      data-date={date}
      aria-label={cellLabel(date, day, note, expectedCount)}
      aria-pressed={inside}
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
      }`}
    >
      {/* The date, large and centred; expected and pending marks in the corners. */}
      <div className="relative flex justify-center">
        {expectedCount > 0 && (
          <span
            className="absolute top-0 left-0 text-[10px] text-amber-700 dark:text-amber-400"
            title={`${expectedCount} expected`}
            aria-hidden="true"
          >
            ↻{expectedCount}
          </span>
        )}
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full text-base font-semibold ${
            isToday
              ? "bg-white text-slate-900 shadow ring-1 ring-slate-300"
              : "text-slate-700 dark:text-slate-200"
          }`}
        >
          {Number(date.slice(8))}
        </span>
        {day && day.pendingCount > 0 && (
          <span
            className="absolute top-0 right-0 text-[10px] text-amber-600"
            title={`${day.pendingCount} pending`}
            aria-hidden="true"
          >
            ●
          </span>
        )}
      </div>

      {day && <DayTotals day={day} />}

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
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color ?? "#94a3b8" }}
              />
            ))}
            {day.categories.length > MAX_DOTS && (
              <span
                className="text-[9px] text-slate-500"
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
                  className="h-4 w-4 rounded-full bg-white object-contain ring-1 ring-white dark:ring-slate-900"
                />
              ) : (
                <span
                  key={b.key}
                  title={b.name}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white ring-1 ring-white dark:ring-slate-900"
                  style={{ backgroundColor: b.color ?? "#475569" }}
                >
                  {b.key === "manual" ? "✋" : b.name.slice(0, 1).toUpperCase()}
                </span>
              ),
            )}
            {banks.length > MAX_LOGOS && (
              <span className="pl-1.5 text-[9px] text-slate-500">+{banks.length - MAX_LOGOS}</span>
            )}
          </span>
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
      className="flex flex-wrap items-center justify-center gap-x-1.5 text-[10px] leading-4 font-medium tabular-nums"
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
  const [text, setText] = useState(note);
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
      onDone(true);
    } catch (e) {
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
