import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * The app's dropdown, used everywhere instead of the browser's. It takes the same things a native
 * `<select>` does (`value`, `onChange` with `e.target.value`, `<option>` and `<optgroup>`
 * children, `id`, `disabled`, `className`, `aria-*`), so swapping one in is a change of tag. On
 * top of that:
 *
 * - An option can be indented (`data-depth="1"` for a subcategory under its category), and can
 *   show something else in the closed box than in the list (`data-shown`).
 * - Long lists get a search box; typing on a closed or open list jumps to the next match.
 * - The list floats over everything (it is drawn at the top of the page), so dialogs and
 *   scrolling panels never cut it off, and it opens upward when there is no room below.
 * - Keyboard: arrows, Home/End, Enter or Space to choose, Escape to close, Tab to move on.
 */

export interface SelectChangeEvent {
  target: { value: string; name?: string };
  currentTarget: { value: string; name?: string };
}

interface Option {
  value: string;
  label: string;
  shown: string;
  disabled: boolean;
  depth: number;
  group: string | null;
}

export interface SelectProps {
  value?: string | number | readonly string[] | undefined;
  defaultValue?: string | number | undefined;
  onChange?: ((event: SelectChangeEvent) => void) | undefined;
  children?: ReactNode;
  id?: string | undefined;
  name?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  className?: string | undefined;
  title?: string | undefined;
  /** Show a search box above the list (default: when there are more than 12 options). */
  searchable?: boolean | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | "true" | "false" | undefined;
}

const SEARCH_AFTER = 12;

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

type OptionProps = {
  value?: string | number;
  children?: ReactNode;
  disabled?: boolean;
  "data-depth"?: string | number;
  "data-shown"?: string;
  label?: string;
};

/** The options, in order, from `<option>` and `<optgroup>` children (fragments and arrays too). */
function readOptions(children: ReactNode, group: string | null = null): Option[] {
  const out: Option[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<OptionProps & { label?: string }>;
    if (el.type === "optgroup") {
      out.push(...readOptions(el.props.children, el.props.label ?? null));
    } else if (el.type === "option") {
      const label = textOf(el.props.children) || el.props.label || "";
      const value = el.props.value === undefined ? label : String(el.props.value);
      out.push({
        value,
        label,
        shown: el.props["data-shown"] ?? label,
        disabled: el.props.disabled === true,
        depth: Number(el.props["data-depth"] ?? 0) || 0,
        group,
      });
    } else {
      // A fragment or a component wrapping options.
      out.push(...readOptions((el.props as { children?: ReactNode }).children, group));
    }
  });
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function Select({
  value,
  defaultValue,
  onChange,
  children,
  id,
  name,
  disabled,
  className = "",
  title,
  searchable,
  ...aria
}: SelectProps) {
  const options = useMemo(() => readOptions(children), [children]);
  const [inner, setInner] = useState(
    defaultValue === undefined ? (options[0]?.value ?? "") : String(defaultValue),
  );
  const current = value === undefined ? inner : String(value);
  const selected = options.find((o) => o.value === current) ?? null;

  const autoId = useId();
  const buttonId = id ?? `${autoId}-button`;
  const listId = `${autoId}-list`;
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<CSSProperties>({});
  const typed = useRef({ text: "", at: 0 });

  const withSearch = searchable ?? options.length > SEARCH_AFTER;
  const shownOptions = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return options;
    return options.filter((o) => norm(o.label).includes(q) || norm(o.group ?? "").includes(q));
  }, [options, query]);

  const choose = useCallback(
    (option: Option | undefined) => {
      if (!option || option.disabled) return;
      if (value === undefined) setInner(option.value);
      const target = { value: option.value, ...(name ? { name } : {}) };
      if (option.value !== current) onChange?.({ target, currentTarget: target });
      setOpen(false);
      button.current?.focus();
    },
    [current, name, onChange, value],
  );

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
  };

  // Where the list goes: under the button, or above it when there is no room below.
  const position = useCallback(() => {
    const box = button.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    const up = below < 220 && above > below;
    const room = Math.max(120, Math.min(320, up ? above : below));
    setPlace({
      position: "fixed",
      left: Math.max(8, Math.min(box.left, window.innerWidth - Math.max(box.width, 180) - 8)),
      minWidth: box.width,
      maxWidth: Math.max(box.width, Math.min(420, window.innerWidth - 16)),
      maxHeight: room,
      ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    position();
    const index = shownOptions.findIndex((o) => o.value === current);
    setActive(index >= 0 ? index : shownOptions.findIndex((o) => !o.disabled));
    if (withSearch) search.current?.focus();
    else list.current?.focus();
    // Only when it opens.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (button.current?.contains(t) || list.current?.parentElement?.contains(t)) return;
      setOpen(false);
    };
    const reposition = () => position();
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, position]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // A new search starts at its first match.
  useEffect(() => {
    if (open) setActive(shownOptions.findIndex((o) => !o.disabled));
  }, [query]);

  const move = (from: number, step: number): number => {
    if (shownOptions.length === 0) return -1;
    let i = from;
    for (let n = 0; n < shownOptions.length; n++) {
      i = (i + step + shownOptions.length) % shownOptions.length;
      if (!shownOptions[i]!.disabled) return i;
    }
    return from;
  };

  /** Typing letters jumps to the next option starting with them. */
  const typeAhead = (key: string): number | null => {
    const now = Date.now();
    typed.current = {
      text: (now - typed.current.at < 700 ? typed.current.text : "") + key.toLowerCase(),
      at: now,
    };
    const start = Math.max(0, open ? active : options.findIndex((o) => o.value === current));
    const pool = open ? shownOptions : options;
    for (let n = 1; n <= pool.length; n++) {
      const i = (start + (typed.current.text.length > 1 ? n - 1 : n)) % pool.length;
      if (!pool[i]!.disabled && norm(pool[i]!.label.trim()).startsWith(typed.current.text))
        return i;
    }
    return null;
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openList();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = typeAhead(e.key);
      if (i !== null) choose(options[i]);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => move(a, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => move(a < 0 ? 0 : a, -1));
        break;
      case "Home":
        if (e.target === search.current) return;
        e.preventDefault();
        setActive(move(-1, 1));
        break;
      case "End":
        if (e.target === search.current) return;
        e.preventDefault();
        setActive(move(0, -1));
        break;
      case "Enter":
        e.preventDefault();
        choose(shownOptions[active]);
        break;
      case " ":
        if (e.target === search.current) return;
        e.preventDefault();
        choose(shownOptions[active]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // a dialog around it stays open
        setOpen(false);
        button.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.target !== search.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          const i = typeAhead(e.key);
          if (i !== null) setActive(i);
        }
    }
  };

  // The closed box looks like the app's other inputs (the className given), with an arrow.
  const box = (
    <button
      ref={button}
      type="button"
      id={buttonId}
      name={name}
      title={title}
      disabled={disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      {...aria}
      onClick={() => (open ? setOpen(false) : openList())}
      onKeyDown={onButtonKey}
      className={`${className} relative inline-flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
        className.includes("w-") || className.includes("block") ? "" : "min-w-[8rem]"
      }`}
    >
      <span className={`truncate ${selected ? "" : "text-slate-400"}`}>
        {selected ? selected.shown : "Choose..."}
      </span>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 opacity-70">
        <path
          d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  let lastGroup: string | null = null;
  const popup = open
    ? createPortal(
        <div
          style={place}
          className="z-[1000] flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white text-sm text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          onKeyDown={onListKey}
        >
          {withSearch && (
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              aria-label="Search the list"
              aria-controls={listId}
              className="m-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-blue-500 dark:border-slate-600 dark:bg-slate-900"
            />
          )}
          <ul
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={buttonId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="overflow-y-auto py-1 outline-none"
          >
            {shownOptions.length === 0 && (
              <li className="px-3 py-1.5 text-slate-500">Nothing matches.</li>
            )}
            {shownOptions.map((o, i) => {
              const heading =
                o.group !== null && o.group !== lastGroup ? (
                  <li
                    key={`g-${o.group}-${i}`}
                    role="presentation"
                    className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase"
                  >
                    {o.group}
                  </li>
                ) : null;
              lastGroup = o.group;
              const isSelected = o.value === current;
              return [
                heading,
                <li
                  key={`${o.value}-${i}`}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={o.disabled || undefined}
                  onMouseMove={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  style={{ paddingLeft: `${0.75 + o.depth * 1.1 + (o.group ? 0.5 : 0)}rem` }}
                  className={`flex cursor-default items-center gap-2 py-1.5 pr-3 ${
                    o.disabled ? "text-slate-400" : i === active ? "bg-blue-600 text-white" : ""
                  } ${o.depth === 0 && options.some((x) => x.depth > 0) ? "font-medium" : ""}`}
                >
                  {o.depth > 0 && (
                    <span aria-hidden="true" className="opacity-50">
                      ↳
                    </span>
                  )}
                  <span className="flex-1 truncate">{o.label || " "}</span>
                  {isSelected && (
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0">
                      <path
                        d="M3.5 8.5l3 3 6-7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </li>,
              ];
            })}
          </ul>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {box}
      {popup}
    </>
  );
}
