import { useState } from "react";
import { cancelled, type Phase, type Session } from "../lib/session";
import { Button, Notice, Page } from "./ui";

/** First run, or after forgetting: scan the PC's code, then pick the file. */
export function PairScreen({
  session,
  onPhase,
}: {
  session: Session;
  onPhase: (p: Phase) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onPhase(await session.pair());
    } catch (e) {
      if (!cancelled(e)) setError(e instanceof Error ? e.message : "Pairing did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Finance Viewer">
      <p>
        A read-only view of your Personal Finance app, from a copy your PC writes after each sync.
        No bank sign-in or Plaid key is ever on this phone.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          On the PC, open <strong>Settings &gt; Data &amp; backups &gt; Phone viewer</strong>, name
          this phone and choose <strong>Pair and show the code</strong>.
        </li>
        <li>Scan the code here. Your fingerprint or screen lock then protects its key.</li>
        <li>Pick the snapshot file in Google Drive.</li>
      </ol>
      {error && <Notice kind="error">{error}</Notice>}
      <Button primary disabled={busy} onClick={() => void pair()}>
        {busy ? "Working..." : "Pair with PC"}
      </Button>
    </Page>
  );
}

export function PickFileScreen({
  session,
  phase,
  onPhase,
}: {
  session: Session;
  phase: Extract<Phase, { kind: "needFile" }>;
  onPhase: (p: Phase) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onPhase(await session.pick());
    } catch (e) {
      if (!cancelled(e)) setError(e instanceof Error ? e.message : "Could not open that file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Pick the snapshot">
      {phase.problem && <Notice kind="error">{phase.problem}</Notice>}
      <p>
        In the file picker, open <strong>Google Drive</strong> and choose{" "}
        {phase.expectedName ? (
          <strong className="break-all">{phase.expectedName}</strong>
        ) : (
          "this phone's .snap file"
        )}
        , in the folder you chose on the PC.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Not there yet? The PC writes it a few seconds after pairing. Give Google Drive a moment to
        sync, then try again.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      <Button primary disabled={busy} onClick={() => void pick()}>
        {busy ? "Working..." : "Pick the file"}
      </Button>
      <Button
        onClick={() => {
          if (window.confirm("Forget the pairing on this phone?")) {
            void session.forget().then(onPhase);
          }
        }}
      >
        Start over
      </Button>
    </Page>
  );
}

/** The app lock: the phone's fingerprint, face or screen lock unwraps the key. */
export function LockedScreen({
  session,
  problem,
  onPhase,
}: {
  session: Session;
  problem: string | null;
  onPhase: (p: Phase) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(problem);

  async function unlock(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onPhase(await session.load());
    } catch (e) {
      if (!cancelled(e)) setError(e instanceof Error ? e.message : "Could not unlock.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Finance Viewer">
      <p>Unlock with your fingerprint, face or screen lock.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <Button primary disabled={busy} onClick={() => void unlock()}>
        {busy ? "Opening..." : "Unlock"}
      </Button>
    </Page>
  );
}
