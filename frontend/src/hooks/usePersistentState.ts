import { useEffect, useState } from "react";

/**
 * State that survives leaving the page (and restarting the app): kept in the browser's local
 * storage under `key`. For an object, saved fields are laid over `initial`, so a setting added
 * later still gets its default. Storage can be unavailable (a private window, blocked site data);
 * then it simply behaves like useState.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === "function" ? (initial as () => T)() : initial;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved === null) return fallback;
      const parsed = JSON.parse(saved) as T;
      if (
        fallback !== null &&
        typeof fallback === "object" &&
        !Array.isArray(fallback) &&
        parsed !== null &&
        typeof parsed === "object"
      ) {
        return { ...fallback, ...parsed };
      }
      return typeof parsed === typeof fallback ? parsed : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not saved; it still works for this visit.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
