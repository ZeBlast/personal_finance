import { Component, type ErrorInfo, type ReactNode } from "react";
import { resolveConfig } from "./config";
import { getWidget } from "./registry";
import { readAppearance } from "./appearance";
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
}

const smallButton =
  "rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700";

/** One widget on the dashboard: its title bar (the drag handle), its content, and edit controls. */
export function WidgetCard({ widget, editing, onConfigure, onHide, onRemove }: Props) {
  const definition = getWidget(widget.widgetType);
  const look = readAppearance(widget.config);
  const title = look.title || (definition?.title ?? "Unavailable widget");
  // The title bar always shows while editing: it is what the widget is dragged by.
  const showHeader = editing || !look.hideHeader;

  return (
    <article
      aria-label={title}
      style={look.accent ? { borderLeft: `5px solid ${look.accent}` } : undefined}
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-slate-800 ${
        editing ? "border-dashed border-blue-400" : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <header
        hidden={!showHeader}
        className={`widget-drag-handle flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700 ${
          editing ? "cursor-move bg-blue-50 dark:bg-slate-900" : ""
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
        </h2>
        {editing && (
          <div className="flex shrink-0 items-center gap-1">
            {/* Every widget has settings now: at least its title and look. */}
            {definition && (
              <button
                type="button"
                className={smallButton}
                onClick={onConfigure}
                aria-label={`Settings for ${title}`}
              >
                Settings
              </button>
            )}
            <button
              type="button"
              className={smallButton}
              onClick={onHide}
              aria-label={`Hide ${title}`}
            >
              Hide
            </button>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-sm leading-none text-slate-600 hover:border-red-400 hover:bg-red-50 hover:text-red-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-red-950"
              onClick={onRemove}
              aria-label={`Remove ${title}`}
              title="Remove this widget"
            >
              ✕
            </button>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {definition ? (
          <WidgetErrorBoundary>
            <definition.Component
              config={resolveConfig(definition, widget.config)}
              instanceId={widget.key}
              size={fromGrid({ w: widget.w, h: widget.h })}
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
