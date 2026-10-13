import { resolveConfig } from "./config";
import { WIDGET_GROUPS, type AnyWidget } from "./types";

/**
 * Every file in this folder named `*Widget.tsx` is a widget. They are found here automatically at
 * build time, so adding a widget means adding a file and nothing else.
 */
const modules = import.meta.glob<{ default: AnyWidget }>("./*Widget.tsx", { eager: true });

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/**
 * Checks a definition against the contract and returns a list of problems (empty when it is fine).
 * Runs in development, and in the automated test that covers every widget in this folder, so a
 * mistake in a new widget is reported with a clear message instead of failing in a confusing way.
 */
export function validateWidget(widget: AnyWidget, file = widget.id): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(`${file}: ${message}`);

  if (!ID_PATTERN.test(widget.id))
    bad(`id "${widget.id}" must be lowercase letters, digits and dashes`);
  if (!widget.title.trim()) bad("title is empty");
  if (!widget.description.trim()) bad("description is empty");
  if (!WIDGET_GROUPS.includes(widget.group))
    bad(`group "${widget.group}" is not one of ${WIDGET_GROUPS.join(", ")}`);
  if (typeof widget.Component !== "function") bad("Component is missing");

  const { w, h } = widget.defaultSize;
  if (!Number.isInteger(w) || w < 1 || w > 12)
    bad("defaultSize.w must be a whole number from 1 to 12");
  if (!Number.isInteger(h) || h < 1 || h > 30)
    bad("defaultSize.h must be a whole number from 1 to 30");
  if (widget.minSize) {
    if (widget.minSize.w > w || widget.minSize.h > h) bad("minSize is larger than defaultSize");
    if (widget.minSize.w < 1 || widget.minSize.h < 1) bad("minSize must be at least 1 by 1");
  }

  const fields = widget.configFields ?? [];
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) bad(`setting "${field.key}" is declared twice`);
    keys.add(field.key);
    // Keys starting "_" hold every widget's appearance (see appearance.ts).
    if (field.key.startsWith("_")) bad(`setting "${field.key}" may not start with "_"`);
    if (!field.label.trim()) bad(`setting "${field.key}" has no label`);
    if (field.type === "select") {
      const values = field.options.map((o) => o.value);
      if (values.length === 0) bad(`setting "${field.key}" has no options`);
      if (new Set(values).size !== values.length)
        bad(`setting "${field.key}" has repeated option values`);
    }
    if (field.type === "number" && field.min > field.max)
      bad(`setting "${field.key}" has min above max`);

    const given = widget.defaultConfig?.[field.key];
    if (given === undefined) {
      bad(`defaultConfig is missing a value for "${field.key}"`);
    } else if (resolveConfig(widget, { [field.key]: given })[field.key] !== given) {
      bad(`defaultConfig value for "${field.key}" is not valid for that setting`);
    }
  }
  for (const key of Object.keys(widget.defaultConfig ?? {})) {
    if (!keys.has(key)) bad(`defaultConfig has "${key}" but there is no setting for it`);
  }
  return problems;
}

const widgets = new Map<string, AnyWidget>();
for (const [file, module] of Object.entries(modules)) {
  const widget = module.default;
  const problems = validateWidget(widget, file);
  if (widgets.has(widget.id))
    problems.push(`${file}: id "${widget.id}" is already used by another widget`);
  if (problems.length > 0) {
    // Show the mistake clearly and skip just this widget; the rest of the dashboard still works.
    console.error(`Widget not loaded:\n- ${problems.join("\n- ")}`);
    continue;
  }
  widgets.set(widget.id, widget);
}

/** Every available widget, in a stable order. */
export function allWidgets(): AnyWidget[] {
  return [...widgets.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function getWidget(id: string): AnyWidget | undefined {
  return widgets.get(id);
}

/** Everything found in the folder, including problems, for the automated contract test. */
export function discoveredWidgets(): Array<{ file: string; widget: AnyWidget }> {
  return Object.entries(modules).map(([file, module]) => ({ file, widget: module.default }));
}
