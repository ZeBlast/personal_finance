import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { FakeInstitution } from "../../types/api";
import { Modal } from "../common/Modal";
import { Loading } from "../common/Loading";

interface Props {
  /** Present when re-authenticating an existing connection (update mode). */
  reconnectName?: string | undefined;
  onSuccess: (publicToken: string, institution: { id: string; name: string } | null) => void;
  onCancel: () => void;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Stand-in for Plaid Link in demo mode: pick a demo institution, and the app receives a demo
 * "public token" exactly as it would from the real Link window.
 */
export function FakeLinkDialog({ reconnectName, onSuccess, onCancel }: Props) {
  const [institutions, setInstitutions] = useState<FakeInstitution[] | null>(null);

  useEffect(() => {
    if (reconnectName) return;
    void api<FakeInstitution[]>("/plaid/fake/institutions").then(setInstitutions);
  }, [reconnectName]);

  if (reconnectName) {
    return (
      <Modal title={`Sign in again to ${reconnectName}`} onClose={onCancel}>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Demo mode: this stands in for the bank's sign-in window.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSuccess(`public-fake~update~${randomSuffix()}`, null)}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Sign in
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Connect an account (demo)" onClose={onCancel}>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Demo mode: choose a made-up institution. Nothing leaves your computer.
      </p>
      <ul className="mt-3 space-y-2">
        {institutions?.map((institution) => (
          <li key={institution.id}>
            <button
              type="button"
              onClick={() =>
                onSuccess(`public-fake~${institution.id}~${randomSuffix()}`, {
                  id: institution.id,
                  name: institution.name,
                })
              }
              className="flex w-full items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
            >
              <span className="font-medium">{institution.name}</span>
              <span className="text-xs text-slate-500">
                {institution.accountCount} {institution.accountCount === 1 ? "account" : "accounts"}
              </span>
            </button>
          </li>
        ))}
        {institutions === null && (
          <li>
            <Loading lines={3} />
          </li>
        )}
      </ul>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
