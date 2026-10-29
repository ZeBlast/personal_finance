/**
 * What shows while data loads: grey shimmering bars in roughly the shape of what is coming, so the
 * page doesn't flash a line of text and then jump. Screen readers hear "Loading".
 */
export function Loading({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  // Varying widths read as text rather than a stack of identical boxes.
  const widths = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-1/2"];
  return (
    <div role="status" className={`space-y-2.5 py-1 ${className}`}>
      <span className="sr-only">Loading...</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className={`pf-skeleton h-3.5 ${widths[i % widths.length]}`}
        />
      ))}
    </div>
  );
}

/** The dashboard while it loads: four headline tiles and two cards, in the default layout's shape. */
export function LoadingDashboard() {
  const card =
    "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800";
  return (
    <div role="status" className="mt-4 space-y-3">
      <span className="sr-only">Loading...</span>
      <div aria-hidden="true" className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${card} space-y-2`}>
            <div className="pf-skeleton h-3 w-20" />
            <div className="pf-skeleton h-7 w-32" />
            <div className="pf-skeleton h-2.5 w-40" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="grid grid-cols-3 gap-3">
        <div className={`${card} col-span-2 h-72`}>
          <div className="pf-skeleton h-3.5 w-36" />
          <div className="pf-skeleton mt-4 h-52 w-full" />
        </div>
        <div className={`${card} h-72 space-y-3`}>
          <div className="pf-skeleton h-3.5 w-28" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="pf-skeleton h-3 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A loading placeholder for a headline number: a short label bar and a large figure bar. */
export function LoadingFigure() {
  return (
    <div role="status" className="space-y-2 py-1">
      <span className="sr-only">Loading...</span>
      <div aria-hidden="true" className="pf-skeleton h-3 w-24" />
      <div aria-hidden="true" className="pf-skeleton h-7 w-36" />
    </div>
  );
}
