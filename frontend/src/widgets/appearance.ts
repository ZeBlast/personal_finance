/**
 * How a placed widget looks, the same for every widget: its own title (instead of the widget's
 * name), a hidden title bar for a cleaner board, and an accent colour down its left edge. Kept in
 * the widget's saved settings under reserved keys (they start with "_", which no widget setting
 * may), and checked here, so odd saved values can never break the dashboard.
 */
export interface Appearance {
  /** The title shown instead of the widget's name; "" for the name. */
  title: string;
  /** Hide the title bar when not editing (it always shows while editing, to drag by). */
  hideHeader: boolean;
  /** "#rrggbb", or "" for none. */
  accent: string;
}

export const APPEARANCE_KEYS = {
  title: "_title",
  hideHeader: "_hideHeader",
  accent: "_accent",
} as const;

export const MAX_TITLE = 80;

/** The appearance kept in a widget's saved settings, with anything invalid left at its default. */
export function readAppearance(config: Record<string, unknown> | null | undefined): Appearance {
  const c = config ?? {};
  const title = c[APPEARANCE_KEYS.title];
  const hide = c[APPEARANCE_KEYS.hideHeader];
  const accent = c[APPEARANCE_KEYS.accent];
  return {
    title: typeof title === "string" ? title.trim().slice(0, MAX_TITLE) : "",
    hideHeader: hide === true,
    accent: typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent) ? accent : "",
  };
}

/** The appearance as saved settings (defaults left out, to keep them small). */
export function appearanceConfig(a: Appearance): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (a.title.trim()) out[APPEARANCE_KEYS.title] = a.title.trim().slice(0, MAX_TITLE);
  if (a.hideHeader) out[APPEARANCE_KEYS.hideHeader] = true;
  if (/^#[0-9a-f]{6}$/i.test(a.accent)) out[APPEARANCE_KEYS.accent] = a.accent;
  return out;
}
