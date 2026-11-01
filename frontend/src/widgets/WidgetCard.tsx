import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Copy, EyeOff, Settings2, X } from "lucide-react";
import { resolveConfig } from "./config";
import { getWidget } from "./registry";
import { hasFrame, readAppearance } from "./appearance";
import { fromGrid } from "./layout";
import type { PlacedWidget } from "./types";

/**
 * Keeps one broken widget from taking down the dashboard: if its code throws while rendering, only
 * its own card shows a message.
 */
class WidgetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A widget failed to render:", error.message, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        This widget ran into a problem and could not be shown.
      </p>
    ) : (
      this.props.children
    );
  }
}

interface Props {
  widget: PlacedWidget;
  editing: boolean;
  onConfigure?: () => void;
  onHide?: () => void;
  onRemove?: () => void;
  /** Adds another copy, for widgets that allow more than one. */
  onDuplicate?: () => void;
}

const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-600 hover:bg-white hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100";

/** A ref and whether its element has more to scroll, so only then can the keyboard reach it. */
function useScrollable() {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const check = () => setScrollable(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return { ref, scrollable };
}

/**
 * One widget on the dashboard: its title (the drag handle), its content, and edit controls. Most
 * widgets sit directly on the page with nothing around them; a border is for those busy enough to
 * need one. While editing, every widget shows its edge, so its size and place on the grid are clear.
 */
export function WidgetCard({ widget, editing, onConfigure, onHide, onRemove, onDuplicate }: Props) {
  const definition = getWidget(widget.widgetType);
  const look = readAppearance(widget.config);
  const title = look.title || (definition?.title ?? "Unavailable widget");
  // The title bar always shows while editing: it is what the widget is dragged by.
  const showHeader = editing || !look.hideHeader;
  const framed = hasFrame(look.frame, definition?.framed);
  const size = fromGrid({ w: widget.w, h: widget.h });
  const body = useScrollable();

  return (
    <article
      aria-label={title}
      style={look.accent ? { borderLeft: `3px solid ${look.accent}` } : undefined}
      className={`flex h-full flex-col overflow-hidden ${
        editing
          ? "rounded-lg border border-dashed border-blue-400 bg-white dark:bg-slate-900"
          : framed
            ? "rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800"
            : ""
      } ${look.accent && !framed && !editing ? "pl-3" : ""}`}
    >
      <header
        hidden={!showHeader}
        className={`widget-drag-handle flex items-center justify-between gap-2 ${
          editing
            ? "cursor-move border-b border-slate-200 bg-blue-50 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-800"
            : framed
              ? "border-b border-slate-200 px-3 py-2 dark:border-slate-700"
              : "pb-1.5"
        }`}
        title={editing ? "Drag to move this widget" : undefined}
      >
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          {editing && (
            <span aria-hidden="true" className="shrink-0 text-slate-400 select-none">
              ⠿
            </span>
          )}
          <span className="truncate">{title}</span>
          {editing && (
            <span
              title="Width and height, in the grid's half steps"
              className="shrink-0 text-xs font-normal text-slate-500 tabular-nums dark:text-slate-400"
            >
              {size.w} × {size.h}
            </span>
          )}
        </h2>
        {editing && (
          <div className="flex shrink-0 items-center">
            {/* Every widget has settings now: at least its title and look. */}
            {definition && (
              <button
                type="button"
                className={iconButton}
                onClick={onConfigure}
                aria-label={`Settings for ${title}`}
                title="Settings"
              >
                <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
            {onDuplicate && (
              <button
                type="button"
                className={iconButton}
                onClick={onDuplicate}
                aria-label={`Copy ${title}`}
                title="Add another copy"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              className={iconButton}
              onClick={onHide}
              aria-label={`Hide ${title}`}
              title="Hide (it stays listed below the dashboard)"
            >
              <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={`${iconButton} hover:text-red-700 dark:hover:text-red-400`}
              onClick={onRemove}
              aria-label={`Remove ${title}`}
              title="Remove this widget"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </header>
      <div
        ref={body.ref}
        {...(body.scrollable ? { tabIndex: 0 } : {})}
        className={`min-h-0 flex-1 overflow-auto ${framed || editing ? "p-3" : ""}`}
      >
        {definition ? (
          <WidgetErrorBoundary>
            <definition.Component
              config={resolveConfig(definition, widget.config)}
              instanceId={widget.key}
              size={size}
            />
          </WidgetErrorBoundary>
        ) : (
          <p className="text-sm text-slate-500">
            This widget (“{widget.widgetType}”) is not available in this version of the app. Your
            settings for it are kept.
          </p>
        )}
      </div>
    </article>
  );
}
