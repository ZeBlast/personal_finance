import { useEffect, useState } from "react";
import { ConfirmDialog } from "./Modal";

interface Ask {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

type Pending = Ask & { resolve: (ok: boolean) => void };

let show: ((pending: Pending) => void) | null = null;

/**
 * Asks a yes/no question in the app's own dialog (instead of the browser's plain confirm box) and
 * resolves to the answer. Needs <ConfirmHost> in the app shell; without it, it answers no.
 */
export function askConfirm(question: Ask | string): Promise<boolean> {
  const ask = typeof question === "string" ? { title: question } : question;
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ ...ask, resolve });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    show = setPending;
    return () => {
      show = null;
    };
  }, []);
  if (!pending) return null;
  const answer = (ok: boolean) => {
    pending.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmDialog
      title={pending.title}
      message={pending.message ?? ""}
      confirmLabel={pending.confirmLabel ?? "OK"}
      danger={pending.danger}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );
}
