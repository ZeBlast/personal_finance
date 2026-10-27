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
  useTrackPages();

  return (
    <div className="relative flex h-screen overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBanner status={status} />
        <DemoBanner />
        <main className="flex-1 overflow-auto p-6">
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
          </Routes>
        </main>
      </div>
    </div>
  );
}
