import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Category } from "../types/api";

/**
 * The categories, loaded once per use. `reload` fetches them again after one is added, renamed,
 * archived or deleted. Archived categories are left out unless `includeInactive` is set.
 */
export function useCategories(includeInactive = false) {
  const [categories, setCategories] = useState<Category[] | null>(null);

  const reload = useCallback(async (): Promise<Category[]> => {
    try {
      const list = await api<Category[]>(
        `/categories${includeInactive ? "?includeInactive=1" : ""}`,
      );
      setCategories(list);
      return list;
    } catch {
      setCategories((previous) => previous ?? []);
      return [];
    }
  }, [includeInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { categories, reload };
}

/** Marks a main category in a picker. */
export const MAIN_MARK = "■";
/** Indents a subcategory under its main category in a picker. */
export const SUB_MARK = "\u00a0\u00a0\u00a0\u00a0└\u00a0";

/**
 * Categories for a picker, each main category followed by its subcategories. `label` is what a
 * dropdown shows: a main category marked with a square, a subcategory indented under it with a
 * branch ("■ Transportation", "    └ Gas"), since a plain dropdown cannot use bold or colour.
 * `name` is the category's own name, for text elsewhere ("Always categorize as Gas").
 */
export function categoryOptions(
  categories: Category[],
): Array<{ id: number; label: string; name: string; sub: boolean }> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return categories
    .map((c) => {
      const parent = c.parentId === null ? undefined : byId.get(c.parentId);
      return {
        id: c.id,
        name: c.name,
        sub: parent !== undefined,
        label: parent ? `${SUB_MARK}${c.name}` : `${MAIN_MARK} ${c.name}`,
        // A subcategory sorts right after its main category, before the next main one.
        sortKey: parent
          ? [parent.name.toLowerCase(), 1, c.name.toLowerCase()]
          : [c.name.toLowerCase(), 0, ""],
      };
    })
    .sort((a, b) => {
      const [an, al, ac] = a.sortKey;
      const [bn, bl, bc] = b.sortKey;
      return (
        String(an).localeCompare(String(bn)) ||
        Number(al) - Number(bl) ||
        String(ac).localeCompare(String(bc))
      );
    })
    .map(({ id, label, name, sub }) => ({ id, label, name, sub }));
}
