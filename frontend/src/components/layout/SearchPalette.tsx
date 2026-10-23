import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { routes } from "../../app/routes";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Account, Category, TransactionPage } from "../../types/api";

interface Result {
  key: string;
  group: "Pages" | "Accounts" | "Categories" | "Transactions";
  title: string;
  detail: string;
  /** Where choosing it goes. */
  to: string;
}

const GROUPS: Result["group"][] = ["Pages", "Accounts", "Categories", "Transactions"];

/** Words that find a page without being in its name. */
const PAGE_WORDS: Record<string, string> = {
  "/": "home overview",
  "/transactions": "spending purchases",
  "/transactions/review": "uncategorized duplicates queue",
  "/transactions/categories": "rules merchants",
  "/planning": "forecast bills paychecks planning",
  "/planning/subscriptions": "recurring charges deposits memberships streaming netflix renewals",
  "/planning/budgets": "limits",
  "/planning/goals": "savings target",
  "/planning/debt": "loans payoff interest apr",
  "/accounts": "credit utilization reconcile banks",
  "/accounts/investments": "tsp retirement brokerage returns",
  "/reports": "month report",
  "/reports/spending": "insights category explorer trends",
  "/reports/net-worth": "history analytics",
  "/reports/network": "graph",
  "/settings/data": "backup export folder diagnostics",
  "/settings": "plaid preferences",
  "/taxes": "irs fica withholding",
};

const matches = (text: string, q: string): boolean => text.toLowerCase().includes(q);

/**
 * Searching the whole app (Ctrl+K, or the button in the sidebar): pages, accounts, categories, and
 * transactions (by merchant, note, people, category, or an exact amount). The arrow keys move
 * through the results; Enter opens one.
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [found, setFound] = useState<TransactionPage | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    api<Account[]>("/accounts?includeHidden=1")
      .then(setAccounts)
      .catch(() => undefined);
    api<Category[]>("/categories")
      .then(setCategories)
      .catch(() => undefined);
  }, []);

  // Transactions, a moment after typing stops.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<TransactionPage>(`/transactions?pageSize=8&q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (!cancelled) setFound(r);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const results = useMemo<Result[]>(() => {
    const term = q.trim().toLowerCase();
    if (term === "") {
      return routes.map((r) => ({
        key: `page:${r.path}`,
        group: "Pages",
        title: r.label,
        detail: "Page",
        to: r.path,
      }));
    }
    const out: Result[] = [];
    for (const r of routes) {
      if (matches(`${r.label} ${PAGE_WORDS[r.path] ?? ""}`, term)) {
        out.push({
          key: `page:${r.path}`,
          group: "Pages",
          title: r.label,
          detail: "Page",
          to: r.path,
        });
      }
    }
    for (const a of accounts) {
      if (matches(`${a.name} ${a.institutionName ?? ""} ${a.officialName ?? ""}`, term)) {
        out.push({
          key: `account:${a.id}`,
          group: "Accounts",
          title: a.name,
          detail: `${a.institutionName ?? "Kept by hand"} · ${formatMinor(a.currentBalanceMinor, a.currency)}`,
          to: `/transactions?account=${a.id}`,
        });
      }
    }
    const byId = new Map(categories.map((c) => [c.id, c]));
    for (const c of categories) {
      if (!c.active || !matches(c.name, term)) continue;
      const parent = c.parentId === null ? undefined : byId.get(c.parentId);
      out.push({
        key: `category:${c.id}`,
        group: "Categories",
        title: c.name,
        detail: parent ? `in ${parent.name}` : "Category",
        to: `/transactions?category=${c.id}`,
      });
    }
    for (const t of found?.items ?? []) {
      out.push({
        key: `tx:${t.id}`,
        group: "Transactions",
        title: t.merchant,
        detail: `${formatDay(t.authorizedDate ?? t.date)} · ${t.amountMinor < 0 ? "+" : "−"}${formatMinor(Math.abs(t.amountMinor), t.currency)} · ${t.accountName}`,
        to: `/transactions?focus=${t.id}&account=${t.accountId}`,
      });
    }
    // Grouped in a fixed order, a handful of each.
    return GROUPS.flatMap((g) =>
      out.filter((r) => r.group === g).slice(0, g === "Transactions" ? 8 : 5),
    );
  }, [q, accounts, categories, found]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.to);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-xl dark:bg-slate-800">
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={results[active] ? `search-${results[active].key}` : undefined}
          aria-label="Search transactions, accounts, categories, and pages"
          placeholder="Search transactions, amounts, accounts, categories, pages..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="w-full border-b border-slate-200 bg-transparent px-4 py-3 text-base outline-none dark:border-slate-700"
        />
        <ul
          id="search-results"
          role="listbox"
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto py-1"
        >
          {results.length === 0 && (
            <li className="px-4 py-3 text-sm text-slate-500">
              {q.trim().length < 2 ? "Keep typing..." : "Nothing found."}
            </li>
          )}
          {results.map((r, i) => (
            <li key={r.key}>
              {(i === 0 || results[i - 1]!.group !== r.group) && (
                <div className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  {r.group}
                </div>
              )}
              <button
                type="button"
                id={`search-${r.key}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => open(r)}
                className={`flex w-full items-baseline justify-between gap-3 px-4 py-1.5 text-left text-sm ${
                  i === active ? "bg-blue-600 text-white" : ""
                }`}
              >
                <span className="truncate font-medium">{r.title}</span>
                <span
                  className={`shrink-0 text-xs ${i === active ? "text-blue-100" : "text-slate-500"}`}
                >
                  {r.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-slate-200 px-4 py-1.5 text-xs text-slate-500 dark:border-slate-700">
          ↑ ↓ to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
