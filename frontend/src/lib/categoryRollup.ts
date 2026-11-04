import type { Category } from "../types/api";

/**
 * The subcategories under a main category, by name (active ones, in list order), for the views that
 * add subcategories into their main category. Empty when the name is not a main category or it has
 * none. Pure.
 */
export function childNames(categories: Category[], parentName: string): string[] {
  const parent = categories.find((c) => c.parentId === null && c.name === parentName);
  if (!parent) return [];
  return categories.filter((c) => c.parentId === parent.id && c.active).map((c) => c.name);
}

/** A tooltip for one rolled-up item: its name, then the subcategories it adds together. Pure. */
export function rolledUpTitle(label: string, children: string[], extra = ""): string {
  const base = children.length > 0 ? `${label}. Includes ${children.join(", ")}` : label;
  return extra ? `${base}. ${extra}` : base;
}
