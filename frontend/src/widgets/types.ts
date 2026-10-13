import type { ComponentType } from "react";

/**
 * THE WIDGET CONTRACT
 *
 * A dashboard widget is one file in this folder, named `SomethingWidget.tsx`, whose default export is
 * `defineWidget({...})`. That is the whole job: the registry finds the file by itself, and the
 * dashboard builds everything else from the declaration:
 *
 *   - the "Add widget" picker (title, description, group),
 *   - the settings dialog (from `configFields`, so no form code per widget),
 *   - the default layout on first run (from `defaultEnabled`, `defaultSize`, `order`),
 *   - sanity checks on saved settings, so old or damaged settings can never crash a widget.
 *
 * Nothing else needs editing: no list to add the widget to, no route, no server change. Widgets get
 * their data from the existing API (most from `/analytics/summary`) with the `useApi` hook. See
 * `README.md` in this folder and `TemplateWidget.example.tsx` for a copy-and-edit starting point.
 */

/** Settings are plain values so they save as JSON and can be edited by a generic form. */
export type ConfigValue = string | number | boolean;
export type WidgetConfig = Record<string, ConfigValue>;

/** One setting of a widget. The settings dialog is built from these. */
export type ConfigField = { key: string; label: string; help?: string } & (
  | { type: "select"; options: ReadonlyArray<{ value: string; label: string }> }
  | { type: "number"; min: number; max: number; step?: number }
  | { type: "boolean" }
  | { type: "text"; maxLength?: number }
  /**
   * Stored as the account's ID, or "" for all. `accountType` limits the choices to one kind of
   * account (for example "investment"), and `allLabel` words the "no filter" choice.
   */
  | { type: "account"; accountType?: string; allLabel?: string }
  /** Stored as the category's ID, or "" for all categories. */
  | { type: "category" }
  /** Stored as a bank's name, "manual" for accounts kept by hand, or "" for all banks. */
  | { type: "institution" }
);

export type WidgetGroup = "Accounts" | "Spending" | "Budgets" | "Activity" | "Tools";

/** Groups in the order the picker shows them. */
export const WIDGET_GROUPS: readonly WidgetGroup[] = [
  "Accounts",
  "Spending",
  "Budgets",
  "Activity",
  "Tools",
];

export interface WidgetSize {
  /** Columns, out of 12. */
  w: number;
  /** Rows. */
  h: number;
}

export interface WidgetProps<C extends WidgetConfig = WidgetConfig> {
  /** The widget's settings, already checked and completed with defaults. */
  config: C;
  /** Which placed copy this is; the same widget can be on the dashboard more than once. */
  instanceId: number | string;
  /** Its current size, if the content should adapt (for example to show fewer rows). */
  size: WidgetSize;
}

export interface WidgetDefinition<C extends WidgetConfig = WidgetConfig> {
  /**
   * Stable ID, lowercase letters, digits and dashes. It is saved with every placed widget, so never
   * change it once people may have the widget on their dashboard.
   */
  id: string;
  title: string;
  /** One sentence for the "Add widget" picker. */
  description: string;
  group: WidgetGroup;
  defaultSize: WidgetSize;
  minSize?: WidgetSize;
  /** Part of the dashboard a new user gets. */
  defaultEnabled?: boolean;
  /** Place in that first dashboard (lower comes first). */
  order?: number;
  /** Allow only one copy on the dashboard. */
  singleton?: boolean;
  /** Values for every field in `configFields`. */
  defaultConfig?: C;
  configFields?: ConfigField[];
  Component: ComponentType<WidgetProps<C>>;
}

/** What the registry stores: a definition whose settings type has been erased. */
export type AnyWidget = WidgetDefinition<WidgetConfig>;

/**
 * Declares a widget. It only gives the settings type to TypeScript; at runtime it returns the
 * definition unchanged.
 */
export function defineWidget<C extends WidgetConfig>(definition: WidgetDefinition<C>): AnyWidget {
  return definition as unknown as AnyWidget;
}

/** One widget placed on the dashboard, as the UI edits it. */
export interface PlacedWidget {
  /** Stable key for the UI: the saved ID, or a temporary one for a widget not saved yet. */
  key: string;
  /** Absent until the widget has been saved. */
  id?: number;
  widgetType: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}
