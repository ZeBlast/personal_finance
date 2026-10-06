import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "../components/common/Modal";
import { DashboardSwitcher } from "../components/dashboard/DashboardSwitcher";
import { useApi } from "../hooks/useApi";
import type { DashboardList } from "../types/analytics";
import { useDashboard } from "../hooks/useDashboard";
import { GRID_COLUMNS, nextFreeY, placeNew } from "../widgets/layout";
import { AddWidgetDialog } from "../widgets/AddWidgetDialog";
import { getWidget } from "../widgets/registry";
import { WidgetCard } from "../widgets/WidgetCard";
import { WidgetSettingsDialog } from "../widgets/WidgetSettingsDialog";
import type { PlacedWidget } from "../widgets/types";

const ROW_HEIGHT = 60;
const MARGIN: [number, number] = [12, 12];

const buttonClass =
  "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";
const primaryClass =
  "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";

/**
 * The draggable grid. It lives in its own component so that the width measurement starts when its
 * container exists: measuring from the page itself would start while "Loading..." is shown, find
 * no container, and never measure, leaving the grid stuck at its default width.
 */
function WidgetGrid({
  layout,
  editing,
  onLayoutChange,
  children,
}: {
  layout: Layout;
  editing: boolean;
  onLayoutChange: (next: Layout) => void;
  children: ReactNode;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={layout}
          gridConfig={{
            cols: GRID_COLUMNS,
            rowHeight: ROW_HEIGHT,
            margin: MARGIN,
            containerPadding: [0, 0],
            maxRows: Infinity,
          }}
          dragConfig={{
            enabled: editing,
            handle: ".widget-drag-handle",
            bounded: false,
            threshold: 3,
          }}
          resizeConfig={{ enabled: editing, handles: ["se"] }}
          onLayoutChange={onLayoutChange}
        >
          {children}
        </ReactGridLayout>
      )}
    </div>
  );
}

/** One dashboard's widgets and the Customize controls. `switcher` is drawn beside the title. */
function DashboardView({
  dashboardId,
  switcher,
}: {
  dashboardId: number;
  switcher: (editing: boolean) => ReactNode;
}) {
  const dashboard = useDashboard(dashboardId);
  const { widgets, editing, update } = dashboard;
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<PlacedWidget | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  if (widgets === null) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-slate-500">Loading...</p>
      </section>
    );
  }

  const visible = widgets.filter((w) => w.enabled);
  const hidden = widgets.filter((w) => !w.enabled);

  const layout: Layout = visible.map((w) => {
    const min = getWidget(w.widgetType)?.minSize;
    return { i: w.key, x: w.x, y: w.y, w: w.w, h: w.h, minW: min?.w ?? 2, minH: min?.h ?? 2 };
  });

  /** Moving or resizing in edit mode updates the draft; ignored otherwise and when nothing changed. */
  function onLayoutChange(next: Layout): void {
    if (!editing) return;
    update((current) => {
      let changed = false;
      const result = current.map((w) => {
        const item = next.find((n) => n.i === w.key);
        if (!item || (item.x === w.x && item.y === w.y && item.w === w.w && item.h === w.h))
          return w;
        changed = true;
        return { ...w, x: item.x, y: item.y, w: item.w, h: item.h };
      });
      return changed ? result : current;
    });
  }

  const patch = (key: string, change: Partial<PlacedWidget>): void =>
    update((current) => current.map((w) => (w.key === key ? { ...w, ...change } : w)));

  const configuringDefinition = configuring ? getWidget(configuring.widgetType) : undefined;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          {switcher(editing)}
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <button type="button" className={buttonClass} onClick={() => setAdding(true)}>
                Add widget
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => setConfirmReset(true)}
                disabled={dashboard.saving}
              >
                Reset to default
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={dashboard.cancelEditing}
                disabled={dashboard.saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className={primaryClass}
                onClick={() => void dashboard.save()}
                disabled={dashboard.saving}
              >
                {dashboard.saving ? "Saving..." : "Done"}
              </button>
            </>
          ) : (
            <button type="button" className={buttonClass} onClick={dashboard.startEditing}>
              Customize
            </button>
          )}
        </div>
      </div>

      {dashboard.error && (
        <p role="alert" className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-900">
          {dashboard.error}
        </p>
      )}
      {editing && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Drag a widget by its title bar, resize it from the bottom-right corner, then press Done to
          save.
        </p>
      )}

      {widgets.length === 0 && !editing && (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-600">
          Your dashboard is empty. Choose Customize, then Add widget.
        </div>
      )}

      {visible.length > 0 && (
        <WidgetGrid layout={layout} editing={editing} onLayoutChange={onLayoutChange}>
          {visible.map((w) => (
            <div key={w.key}>
              <WidgetCard
                widget={w}
                editing={editing}
                onConfigure={() => setConfiguring(w)}
                onHide={() => patch(w.key, { enabled: false })}
                onRemove={() => update((current) => current.filter((x) => x.key !== w.key))}
              />
            </div>
          ))}
        </WidgetGrid>
      )}

      {editing && hidden.length > 0 && (
        <section
          aria-label="Hidden widgets"
          className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
        >
          <h2 className="text-sm font-semibold">Hidden widgets</h2>
          <ul className="mt-2 space-y-1">
            {hidden.map((w) => (
              <li key={w.key} className="flex items-center justify-between gap-3 text-sm">
                <span>{getWidget(w.widgetType)?.title ?? `Unavailable (${w.widgetType})`}</span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      // A re-shown widget goes to the bottom of the dashboard, where it will not overlap anything.
                      update((current) =>
                        current.map((x) =>
                          x.key === w.key
                            ? { ...x, enabled: true, x: 0, y: nextFreeY(current) }
                            : x,
                        ),
                      )
                    }
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => update((c) => c.filter((x) => x.key !== w.key))}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding && (
        <AddWidgetDialog
          placed={widgets}
          onClose={() => setAdding(false)}
          onAdd={(definition) => {
            update((current) => [...current, placeNew(definition, current)]);
            setAdding(false);
          }}
        />
      )}

      {configuring && configuringDefinition && (
        <WidgetSettingsDialog
          widget={configuring}
          definition={configuringDefinition}
          onCancel={() => setConfiguring(null)}
          onSave={(config) => {
            patch(configuring.key, { config });
            setConfiguring(null);
          }}
        />
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset the dashboard?"
          message="This replaces your current widgets and their settings with the default dashboard. This cannot be undone."
          confirmLabel="Reset"
          danger
          busy={dashboard.saving}
          onConfirm={() => {
            setConfirmReset(false);
            void dashboard.resetToDefault();
          }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
}

export function DashboardPage() {
  const boards = useApi<DashboardList>("/dashboards");
  const [problem, setProblem] = useState<string | null>(null);

  if (boards.data === null) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-slate-500">{boards.error ?? "Loading..."}</p>
      </section>
    );
  }
  const list = boards.data;
  return (
    <>
      {problem && (
        <p role="alert" className="mb-3 rounded-md bg-red-100 px-3 py-2 text-sm text-red-900">
          {problem}
        </p>
      )}
      {/* Keyed by dashboard, so switching starts the new one with a clean slate. */}
      <DashboardView
        key={list.active}
        dashboardId={list.active}
        switcher={(editing) => (
          <DashboardSwitcher
            list={list}
            disabled={editing}
            onChanged={() => {
              setProblem(null);
              boards.reload();
            }}
            onError={setProblem}
          />
        )}
      />
    </>
  );
}
