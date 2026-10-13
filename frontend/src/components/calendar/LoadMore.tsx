/** Most transactions the server returns in one page. */
export const PAGE_SIZE = 200;

const smallButton =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

/** "Showing 200 of 340" with a button for the next page, under a list loaded page by page. */
export function LoadMore({
  shown,
  total,
  busy,
  onMore,
}: {
  shown: number;
  total: number;
  busy: boolean;
  onMore: () => void;
}) {
  if (total <= shown) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>
        Showing {shown} of {total}.
      </span>
      <button type="button" className={smallButton} disabled={busy} onClick={onMore}>
        {busy ? "Loading..." : `Load ${Math.min(PAGE_SIZE, total - shown)} more`}
      </button>
    </div>
  );
}
