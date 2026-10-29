import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { announceDataChanged } from "../../lib/syncEvents";
import type { Account, PlaidStatus, Settings } from "../../types/api";

export interface WelcomeStep {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  /** Optional steps never hold the welcome open. */
  optional: boolean;
  to: string;
  action: string;
}

/**
 * The first-run checklist, from what is set up so far. Pure. `plaidKeysSaved` is whether real-bank
 * Plaid keys are saved; the Plaid step is left out while that is unknown.
 */
export function welcomeSteps(
  settings: Settings,
  accountCount: number,
  plaidKeysSaved?: boolean,
): WelcomeStep[] {
  const plaid: WelcomeStep[] =
    plaidKeysSaved === undefined
      ? []
      : [
          {
            key: "plaid",
            title: "Get your Plaid keys (to connect banks)",
            detail:
              "Bank connections go through Plaid. If you don't have a Plaid account yet, create a free one at dashboard.plaid.com, request Production access for personal use (approval can take a few days), then paste your client ID and Production secret in Settings. Skip this if you'd rather import CSVs or type accounts in.",
            done: plaidKeysSaved,
            optional: true,
            to: "/settings?show=bank",
            action: "Set up bank connections",
          },
        ];
  return [
    ...plaid,
    {
      key: "account",
      title: "Add your first account",
      detail:
        "Connect a bank, import your bank's CSV export, or add an account you keep by hand (cash, for example).",
      done: accountCount > 0,
      optional: false,
      to: "/accounts",
      action: "Go to Accounts",
    },
    {
      key: "recovery",
      title: "Save your recovery key",
      detail:
        "Your data is encrypted with a key kept in Windows. If Windows is reinstalled or you change computers, only this key opens your data and backups. Store it in a password manager or on paper.",
      done: settings.recoveryKeySaved,
      optional: false,
      to: "/settings/data?show=recovery-key",
      action: "Show my recovery key",
    },
    {
      key: "categories",
      title: "Look over the categories",
      detail:
        "Transactions are sorted into categories automatically. Rename, add or remove any to match how you think about your money.",
      done: false,
      optional: true,
      to: "/transactions/categories",
      action: "Open categories",
    },
  ];
}

/** Whether everything that matters is set up. Pure. */
export const welcomeComplete = (steps: WelcomeStep[]): boolean =>
  steps.every((s) => s.done || s.optional);

const card =
  "flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";

/**
 * The first-run welcome: three ways to start, and a short checklist. Shown on the dashboard until
 * the user closes it.
 */
export function Welcome({ settings, accounts }: { settings: Settings; accounts: Account[] }) {
  const navigate = useNavigate();
  const [plaidKeysSaved, setPlaidKeysSaved] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    api<PlaidStatus>("/plaid/status")
      .then((status) => setPlaidKeysSaved(status.credentialsSaved.production))
      .catch(() => setPlaidKeysSaved(undefined));
  }, []);
  const steps = welcomeSteps(settings, accounts.length, plaidKeysSaved);
  // Once an account is in, the checklist shrinks to one line so the dashboard starts on screen.
  const [expanded, setExpanded] = useState(false);
  const compact = accounts.length > 0 && !expanded;
  const complete = welcomeComplete(steps);
  const demo = settings.plaidEnvironment === "fake";

  async function dismiss(): Promise<void> {
    await api("/settings", { method: "PATCH", body: JSON.stringify({ welcomeDismissed: true }) });
    announceDataChanged();
  }

  async function tryDemo(): Promise<void> {
    if (!demo) {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ plaidEnvironment: "fake" }),
      });
      announceDataChanged();
    }
    // Accounts then offers "Connect an account" with the sample banks.
    navigate("/accounts");
  }

  if (compact) {
    const left = steps.filter((st) => !st.done);
    return (
      <section
        aria-label="Getting started"
        className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/30"
      >
        <span className="font-medium">
          {complete ? "You're all set" : "Getting started"}
          <span className="ml-1 font-normal text-slate-500">
            {steps.length - left.length} of {steps.length} done
          </span>
        </span>
        {left.map((st) => (
          <Link
            key={st.key}
            to={st.to}
            className="text-blue-700 hover:underline dark:text-blue-300"
          >
            {st.title}
            {st.optional ? " (optional)" : ""} →
          </Link>
        ))}
        <span className="ml-auto flex gap-3">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-slate-600 hover:underline dark:text-slate-300"
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => void dismiss()}
            className="text-slate-600 hover:underline dark:text-slate-300"
          >
            {complete ? "Close" : "Hide"}
          </button>
        </span>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="welcome-heading"
      className="mb-6 space-y-4 rounded-xl border border-blue-200 bg-blue-50/60 p-5 dark:border-blue-900 dark:bg-blue-950/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="welcome-heading" className="text-xl font-semibold">
            {complete ? "You're all set" : "Welcome to Personal Finance"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
            {complete
              ? "Your accounts are in and your recovery key is saved. The dashboard below fills in as transactions arrive."
              : "Everything stays on this computer, encrypted. Start by bringing in your accounts, one of three ways:"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          {complete ? "Close" : "Hide this"}
        </button>
      </div>

      {accounts.length === 0 && (
        <div className="grid gap-3 md:grid-cols-3">
          <div className={card}>
            <h3 className="font-semibold">Connect my banks</h3>
            <p className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Transactions and balances update on their own. This uses Plaid, the service many
              finance apps use; you need a free Plaid account and its keys first. No Plaid account
              yet? Settings walks you through creating one.
            </p>
            <Link
              to="/settings?show=bank"
              className="rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
            >
              Set up bank connections
            </Link>
          </div>
          <div className={card}>
            <h3 className="font-semibold">Import or type them in</h3>
            <p className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              No Plaid needed. Download a CSV of transactions from your bank&apos;s website and
              import it, or keep an account by hand (cash, a gift card).
            </p>
            <Link
              to="/accounts"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-center text-sm font-medium hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              Add an account by hand
            </Link>
          </div>
          <div className={card}>
            <h3 className="font-semibold">Look around first</h3>
            <p className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Load made-up sample banks to see how everything works. Nothing leaves your computer,
              and you can switch to your real accounts later.
            </p>
            <button
              type="button"
              onClick={() => void tryDemo()}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              Try sample data
            </button>
          </div>
        </div>
      )}

      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 dark:bg-slate-900/60"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  s.done
                    ? "bg-green-600 text-white"
                    : "border border-slate-300 text-slate-500 dark:border-slate-600"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0">
                <div className={`font-medium ${s.done ? "text-slate-500 line-through" : ""}`}>
                  {s.title}
                  {s.optional && (
                    <span className="ml-1 text-xs font-normal text-slate-500">(optional)</span>
                  )}
                  <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                </div>
                {!s.done && (
                  <p className="text-xs text-slate-600 dark:text-slate-300">{s.detail}</p>
                )}
              </div>
            </div>
            {!s.done && (
              <Link
                to={s.to}
                className="shrink-0 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
              >
                {s.action} →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
