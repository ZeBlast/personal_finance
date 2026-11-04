import type { Category } from "../types/api";

/**
 * The subcategories under a main category, by name (in list order, archived ones marked
 * "(archived)"), for the views that add subcategories into their main category. Pass the list that
 * includes archived categories, since their past spending still counts. Empty when the name is not
 * a main category or it has none. Pure.
 */
export function childNames(categories: Category[], parentName: string): string[] {
  const parent = categories.find((c) => c.parentId === null && c.name === parentName);
  if (!parent) return [];
  return categories
    .filter((c) => c.parentId === parent.id)
    .map((c) => (c.active ? c.name : `${c.name} (archived)`));
}

/** A tooltip for one rolled-up item: its name, then the subcategories it adds together. Pure. */
export function rolledUpTitle(label: string, children: string[], extra = ""): string {
  const base = children.length > 0 ? `${label}. Includes ${children.join(", ")}` : label;
  return extra ? `${base}. ${extra}` : base;
}
