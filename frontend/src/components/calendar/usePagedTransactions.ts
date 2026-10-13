import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import type { Transaction, TransactionPage } from "../../types/api";

/**
 * Transactions for a query, one page at a time: the first page loads (and reloads after a sync)
 * like any `useApi` call; "load more" adds the next. `total` is the full count, so a list can say
 * how many of how many it shows.
 */
export function usePagedTransactions(query: URLSearchParams) {
  const key = query.toString();
  const first = useApi<TransactionPage>(`/transactions?${key}`);
  const [more, setMore] = useState<{ items: Transaction[]; page: number }>({ items: [], page: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // A new query, or the first page reloaded after a change: start again from it.
  useEffect(() => {
    setMore({ items: [], page: 1 });
    setMoreError(null);
  }, [first.data]);

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const q = new URLSearchParams(key);
      q.set("page", String(more.page + 1));
      const next = await api<TransactionPage>(`/transactions?${q}`);
      setMore((m) => ({ items: [...m.items, ...next.items], page: m.page + 1 }));
    } catch (e) {
      setMoreError(errorMessage(e, "Could not load more transactions."));
    } finally {
      setLoadingMore(false);
    }
  }

  const items = first.data ? [...first.data.items, ...more.items] : null;
  return {
    items,
    total: first.data?.total ?? 0,
    error: first.error ?? moreError,
    loading: first.loading,
    loadingMore,
    hasMore: items !== null && items.length < (first.data?.total ?? 0),
    loadMore,
  };
}
