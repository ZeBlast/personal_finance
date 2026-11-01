/**
 * How a placed widget looks, the same for every widget: its own title (instead of the widget's
 * name), a hidden title bar for a cleaner board, an accent colour down its left edge, and whether it
 * has a border of its own or blends into the dashboard. Kept in
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
  /** A border of its own: what suits the widget (`auto`), always, or never. */
  frame: FrameChoice;
}

export const FRAME_CHOICES = ["auto", "always", "never"] as const;
export type FrameChoice = (typeof FRAME_CHOICES)[number];

/** Whether a widget draws its border: the user's choice, else what the widget asks for. Pure. */
export const hasFrame = (choice: FrameChoice, framedByDefault: boolean | undefined): boolean =>
  choice === "auto" ? framedByDefault === true : choice === "always";

export const APPEARANCE_KEYS = {
  title: "_title",
  hideHeader: "_hideHeader",
  accent: "_accent",
  frame: "_frame",
} as const;

export const MAX_TITLE = 80;

/** The appearance kept in a widget's saved settings, with anything invalid left at its default. */
export function readAppearance(config: Record<string, unknown> | null | undefined): Appearance {
  const c = config ?? {};
  const title = c[APPEARANCE_KEYS.title];
  const hide = c[APPEARANCE_KEYS.hideHeader];
  const accent = c[APPEARANCE_KEYS.accent];
  const frame = c[APPEARANCE_KEYS.frame];
  return {
    title: typeof title === "string" ? title.trim().slice(0, MAX_TITLE) : "",
    hideHeader: hide === true,
    accent: typeof accent === "string" && /^#[0-9a-f]{6}$/i.test(accent) ? accent : "",
    frame: (FRAME_CHOICES as readonly unknown[]).includes(frame) ? (frame as FrameChoice) : "auto",
  };
}

/** The appearance as saved settings (defaults left out, to keep them small). */
export function appearanceConfig(a: Appearance): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (a.title.trim()) out[APPEARANCE_KEYS.title] = a.title.trim().slice(0, MAX_TITLE);
  if (a.hideHeader) out[APPEARANCE_KEYS.hideHeader] = true;
  if (/^#[0-9a-f]{6}$/i.test(a.accent)) out[APPEARANCE_KEYS.accent] = a.accent;
  if (a.frame !== "auto") out[APPEARANCE_KEYS.frame] = a.frame;
  return out;
}
