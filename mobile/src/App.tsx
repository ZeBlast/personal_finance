import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSession, type Phase, type Session } from "./lib/session";
import { AccountsScreen } from "./screens/Accounts";
import { HomeScreen } from "./screens/Home";
import { LockedScreen, PairScreen, PickFileScreen } from "./screens/Setup";
import { SettingsScreen } from "./screens/Settings";
import { Notice, Page } from "./screens/ui";

/** Away longer than this, the app locks again and asks for the fingerprint or screen lock. */
export const LOCK_AFTER_MS = 5 * 60_000;

type Tab = "home" | "accounts" | "settings";

const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "home", label: "Home" },
  { tab: "accounts", label: "Accounts" },
  { tab: "settings", label: "Settings" },
];

export function App({ session: given }: { session?: Session } = {}) {
  const session = useMemo(() => given ?? createSession(), [given]);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [tab, setTab] = useState<Tab>("home");
  const [error, setError] = useState<string | null>(null);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    session
      .start()
      .then(setPhase)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not start."));
  }, [session]);

  // Back from the background: lock after a long absence, otherwise read the file again.
  const onVisibility = useCallback(() => {
    if (document.visibilityState === "hidden") {
      hiddenAt.current = Date.now();
      return;
    }
    const away = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
    hiddenAt.current = null;
    setPhase((current) => {
      if (current.kind !== "ready") return current;
      if (away > LOCK_AFTER_MS) {
        session.lock();
        return { kind: "locked", problem: null };
      }
      void session
        .load()
        .then(setPhase)
        .catch(() => undefined);
      return current;
    });
  }, [session]);

  useEffect(() => {
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [onVisibility]);

  if (error) {
    return (
      <Page title="Finance Viewer">
        <Notice kind="error">{error}</Notice>
      </Page>
    );
  }

  switch (phase.kind) {
    case "starting":
      return <Page title="Finance Viewer">{null}</Page>;
    case "unpaired":
      return <PairScreen session={session} onPhase={setPhase} />;
    case "needFile":
      return <PickFileScreen session={session} phase={phase} onPhase={setPhase} />;
    case "locked":
      return <LockedScreen session={session} problem={phase.problem} onPhase={setPhase} />;
    case "ready":
      return (
        <>
          {tab === "home" && (
            <HomeScreen snapshot={phase.snapshot} source={phase.source} problem={phase.problem} />
          )}
          {tab === "accounts" && <AccountsScreen snapshot={phase.snapshot} />}
          {tab === "settings" && (
            <SettingsScreen session={session} snapshot={phase.snapshot} onPhase={setPhase} />
          )}
          <nav
            className="fixed inset-x-0 bottom-0 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-700 dark:bg-slate-900"
            aria-label="Sections"
          >
            {TABS.map((t) => (
              <button
                key={t.tab}
                type="button"
                aria-current={tab === t.tab ? "page" : undefined}
                className={`min-h-14 flex-1 text-sm font-medium ${
                  tab === t.tab
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
                onClick={() => setTab(t.tab)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </>
      );
  }
}
