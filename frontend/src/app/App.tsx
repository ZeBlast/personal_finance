import { Route, Routes } from "react-router-dom";
import { Sidebar } from "../components/layout/Sidebar";
import { StatusBanner } from "../components/layout/StatusBanner";
import { useBackendStatus } from "../hooks/useBackendStatus";
import { routes } from "./routes";

export function App() {
  const status = useBackendStatus();

  return (
    <div className="relative flex h-screen overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusBanner status={status} />
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            {routes.map(({ path, Page }) => (
              <Route key={path} path={path} element={<Page />} />
            ))}
          </Routes>
        </main>
      </div>
    </div>
  );
}
