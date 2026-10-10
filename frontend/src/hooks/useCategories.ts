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

/** Category names for a picker: subcategories are shown as "Parent › Child", sorted together. */
export function categoryOptions(categories: Category[]): Array<{ id: number; label: string }> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return categories
    .map((c) => {
      const parent = c.parentId === null ? undefined : byId.get(c.parentId);
      // A subcategory shows only its own name; it is listed right after its parent.
      return { id: c.id, label: c.name, sortKey: parent ? `${parent.name}${c.name}` : c.name };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ id, label }) => ({ id, label }));
}
