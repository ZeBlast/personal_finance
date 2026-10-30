import { ConfirmHost } from "../components/common/ConfirmHost";
import { Toaster } from "../components/common/Toaster";
import { NotFound } from "../components/common/NotFound";
import { PageErrorBoundary } from "../components/common/PageErrorBoundary";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { DemoBanner } from "../components/layout/DemoBanner";
import { SectionTabs } from "../components/layout/SectionTabs";
import { Sidebar } from "../components/layout/Sidebar";
import { StatusBanner } from "../components/layout/StatusBanner";
import { useBackendStatus } from "../hooks/useBackendStatus";
import { useTrackPages } from "../hooks/usePreviousPage";
import { areas, LEGACY_PATHS } from "./routes";

/** An old address: opens the page's new one, keeping its filters (`?account=...`) and anchor. */
function MovedTo({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

export function App() {
  const status = useBackendStatus();
  const { pathname } = useLocation();
  useTrackPages();

  return (
    <div className="relative flex h-screen overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      {/* For keyboard users: straight past the sidebar to the page. A button-like link, because the
          app's addresses live after the # and a plain #main link would change the page. */}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only z-50 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <Toaster />
      <ConfirmHost />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBanner status={status} />
        <DemoBanner />
        <main id="main" tabIndex={-1} className="flex-1 overflow-auto p-6 outline-none">
          <PageErrorBoundary resetKey={pathname}>
            <Routes>
              {areas.flatMap((area) =>
                area.sections.map(({ path, Page }) => (
                  <Route
                    key={path}
                    path={path}
                    element={
                      <>
                        <SectionTabs area={area} />
                        <Page />
                      </>
                    }
                  />
                )),
              )}
              {Object.entries(LEGACY_PATHS).map(([from, to]) => (
                <Route key={from} path={from} element={<MovedTo to={to} />} />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </PageErrorBoundary>
        </main>
      </div>
    </div>
  );
}
