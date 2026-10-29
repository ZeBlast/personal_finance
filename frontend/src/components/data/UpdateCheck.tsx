import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { insideTauri } from "../../api/client";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

/** What a failed check means, in words. Pure. */
export function updateErrorText(raw: string): string {
  if (/404|not found/i.test(raw)) {
    return "No published release was found. Updates appear here once a release is published on GitHub.";
  }
  if (/network|connect|dns|timed out|offline/i.test(raw)) {
    return "Could not reach GitHub. Check your internet connection and try again.";
  }
  if (/signature/i.test(raw)) {
    return "The download did not carry a valid signature, so it was not installed.";
  }
  return `Could not check for updates (${raw}).`;
}

/**
 * Checks GitHub for a newer release and installs it. Updates are signed: the app only installs one
 * signed with this project's key. The app backs up your data before a new version first runs.
 */
export function UpdateCheck({ version }: { version: string | null }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  if (!insideTauri) return null;

  async function look(): Promise<void> {
    setState({ kind: "checking" });
    try {
      const update = await check();
      setState(update ? { kind: "available", update } : { kind: "current" });
    } catch (e) {
      setState({ kind: "error", message: updateErrorText(String(e)) });
    }
  }

  async function install(update: Update): Promise<void> {
    let total = 0;
    let done = 0;
    setState({ kind: "installing", percent: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          setState({
            kind: "installing",
            percent: total ? Math.round((done / total) * 100) : null,
          });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: updateErrorText(String(e)) });
    }
  }

  const button =
    "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-medium">Updates</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        You have version {version ?? "..."}. New versions come from this app&apos;s GitHub releases;
        your data is backed up automatically before a new version first runs.
      </p>
      {state.kind === "available" ? (
        <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <p className="font-medium">Version {state.update.version} is available.</p>
          {state.update.body && (
            <p className="whitespace-pre-wrap text-slate-600 dark:text-slate-300">
              {state.update.body}
            </p>
          )}
          <button
            type="button"
            onClick={() => void install(state.update)}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Install and restart
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={button}
          disabled={state.kind === "checking" || state.kind === "installing"}
          onClick={() => void look()}
        >
          {state.kind === "checking"
            ? "Checking..."
            : state.kind === "installing"
              ? `Installing${state.percent === null ? "..." : ` ${state.percent}%`}`
              : "Check for updates"}
        </button>
      )}
      {state.kind === "current" && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          You have the latest version.
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
    </div>
  );
}
