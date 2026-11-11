import { useState } from "react";
import { pickedFile, type Phase, type Session } from "../lib/session";
import type { Snapshot } from "../lib/snapshot";
import { Button, Card, Notice, Page } from "./ui";

export function SettingsScreen({
  session,
  snapshot,
  onPhase,
}: {
  session: Session;
  snapshot: Snapshot;
  onPhase: (p: Phase) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const file = pickedFile();

  return (
    <Page title="Settings">
      <Card title="This phone">
        <dl className="space-y-1 text-sm">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Snapshot file</dt>
            <dd className="break-all">{file?.name ?? "None"}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Written by the PC</dt>
            <dd>
              {new Date(snapshot.body.createdAt).toLocaleString()} (version{" "}
              {snapshot.body.appVersion})
            </dd>
          </div>
          {snapshot.body.failed.length > 0 && (
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Missing from it</dt>
              <dd className="break-all">{snapshot.body.failed.join(", ")}</dd>
            </div>
          )}
        </dl>
      </Card>
      <Button
        onClick={() => {
          void session
            .pick()
            .then(onPhase)
            .catch(() => undefined);
        }}
      >
        Pick the file again
      </Button>
      {confirming ? (
        <Card>
          <Notice kind="warning">
            This erases the key and the copy on this phone. To see your data again, pair again from
            the PC. On the PC, also choose Forget for this phone so it stops writing its file.
          </Notice>
          <Button primary onClick={() => void session.forget().then(onPhase)}>
            Forget this phone
          </Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </Card>
      ) : (
        <Button onClick={() => setConfirming(true)}>Forget this phone...</Button>
      )}
    </Page>
  );
}
