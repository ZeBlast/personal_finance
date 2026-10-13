import type { ConfigField, WidgetConfig, WidgetDefinition } from "./types";

/** The value a field takes when nothing valid is stored. */
function fallbackFor(field: ConfigField): string | number | boolean {
  switch (field.type) {
    case "select":
      return field.options[0]?.value ?? "";
    case "number":
      return field.min;
    case "boolean":
      return false;
    default:
      return "";
  }
}

/** Keeps one stored value if it is valid for its field, otherwise returns the fallback. */
function sanitizeValue(
  field: ConfigField,
  stored: unknown,
  fallback: string | number | boolean,
): string | number | boolean {
  switch (field.type) {
    case "select":
      return typeof stored === "string" && field.options.some((o) => o.value === stored)
        ? stored
        : fallback;
    case "number": {
      if (typeof stored !== "number" || !Number.isFinite(stored)) return fallback;
      const clamped = Math.min(field.max, Math.max(field.min, stored));
      const step = field.step ?? 1;
      return step >= 1 ? Math.round(clamped / step) * step : clamped;
    }
    case "boolean":
      return typeof stored === "boolean" ? stored : fallback;
    case "text":
      return typeof stored === "string" ? stored.slice(0, field.maxLength ?? 200) : fallback;
    case "account":
    case "category":
      return typeof stored === "string" && /^\d*$/.test(stored) ? stored : fallback;
    case "institution":
      return typeof stored === "string" && stored.length <= 200 ? stored : fallback;
  }
}

/**
 * Turns whatever was saved for a widget into settings that are safe to use: unknown keys are
 * dropped, wrong types and out-of-range values are replaced by the widget's default, and missing
 * ones are filled in. A widget therefore never has to defend against odd saved settings, and
 * adding a new setting to a widget in a later version just works for dashboards saved earlier.
 */
export function resolveConfig<C extends WidgetConfig>(
  definition: WidgetDefinition<C>,
  stored: unknown,
): C {
  const source = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const defaults: Record<string, unknown> = definition.defaultConfig ?? {};
  const result: WidgetConfig = {};
  for (const field of definition.configFields ?? []) {
    const fallback = sanitizeValue(field, defaults[field.key], fallbackFor(field));
    result[field.key] = sanitizeValue(field, source[field.key], fallback);
  }
  return result as C;
}
