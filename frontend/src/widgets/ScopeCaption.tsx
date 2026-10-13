import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import type { Account } from "../types/api";
import { scopeLabel } from "./fields";

/**
 * A small line saying what a widget is narrowed to ("Visa · Chase · Groceries"), or nothing when it
 * covers everything. Shared by the widgets that take the account, bank and category settings.
 */
export function ScopeCaption({
  config,
  prefix,
}: {
  config: Record<string, unknown>;
  prefix?: string;
}) {
  const accounts = useApi<Account[]>("/accounts?includeHidden=1");
  const { categories } = useCategories();
  const accountId = typeof config["accountId"] === "string" ? config["accountId"] : "";
  const categoryId = typeof config["categoryId"] === "string" ? config["categoryId"] : "";
  const text = scopeLabel(config, {
    account: accountId ? accounts.data?.find((a) => String(a.id) === accountId)?.name : undefined,
    category: categoryId ? categories?.find((c) => String(c.id) === categoryId)?.name : undefined,
  });
  if (!text && !prefix) return null;
  return (
    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
      {[prefix, text].filter(Boolean).join(" · ")}
    </p>
  );
}
