import { Link, useLocation } from "react-router-dom";

/** An address that matches no page, such as an old bookmark: say so, and offer the way back. */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="max-w-xl space-y-3 py-6">
      <h1 className="text-xl font-semibold">There is no page here</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Nothing in the app lives at <span className="font-mono">{pathname}</span>. It may be an old
        link to a page that has moved. Use the sidebar, or press Ctrl+K to search for it.
      </p>
      <Link
        to="/"
        className="inline-block rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Go to the dashboard
      </Link>
    </div>
  );
}
