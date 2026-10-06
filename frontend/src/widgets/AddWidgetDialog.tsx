import { Modal } from "../components/common/Modal";
import { allWidgets } from "./registry";
import { WIDGET_GROUPS, type AnyWidget, type PlacedWidget } from "./types";

/**
 * The "Add widget" picker. It lists whatever the registry found, grouped, so a new widget file shows
 * up here by itself.
 */
export function AddWidgetDialog({
  placed,
  onAdd,
  onClose,
}: {
  placed: PlacedWidget[];
  onAdd: (widget: AnyWidget) => void;
  onClose: () => void;
}) {
  const widgets = allWidgets();
  const countOf = (id: string) => placed.filter((p) => p.widgetType === id).length;

  return (
    <Modal title="Add a widget" onClose={onClose} wide>
      <div className="space-y-5">
        {WIDGET_GROUPS.map((group) => {
          const inGroup = widgets.filter((w) => w.group === group);
          if (inGroup.length === 0) return null;
          return (
            <section key={group}>
              <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                {group}
              </h3>
              <ul className="mt-2 space-y-2">
                {inGroup.map((widget) => {
                  const count = countOf(widget.id);
                  const blocked = widget.singleton === true && count > 0;
                  return (
                    <li
                      key={widget.id}
                      className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{widget.title}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {widget.description}
                        </div>
                        {count > 0 && (
                          <div className="mt-1 text-xs text-slate-500">
                            {blocked ? "Already on your dashboard." : `${count} on your dashboard.`}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={blocked}
                        onClick={() => onAdd(widget)}
                        aria-label={`Add ${widget.title}`}
                        className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        Add
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
