import type { ReactNode } from "react";
import type { Account } from "../../../types/api";
import { CashbackSection } from "../CashbackSection";
import { Modal } from "../../common/Modal";
import { isStoreCredit } from "../StoreCreditDialogs";

/**
 * The rest of what can be done with an account, behind "More..." on the back of its card (the
 * card itself has room only for the everyday actions): the credit limit's history, checking the
 * balance against a statement, cashback rates, importing a CSV, and deleting an account kept by
 * hand.
 */
export function AccountMoreDialog({
  account: a,
  onLimits,
  onReconcile,
  onImport,
  onDelete,
  onClose,
}: {
  account: Account;
  onLimits: () => void;
  onReconcile: () => void;
  onImport: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const credit = a.type === "credit";
  const storeCredit = isStoreCredit(a);
  const ledger = a.isManual && !storeCredit && ["depository", "credit", "loan"].includes(a.type);

  return (
    <Modal title={`More for ${a.name}`} onClose={onClose} dismissible>
      <div className="space-y-3 text-sm">
        {credit && (
          <Action
            label="Credit limit"
            help="Its limit over time; add, change or remove entries."
            onClick={onLimits}
          />
        )}
        {(a.type === "depository" || credit) && !storeCredit && (
          <Action
            label="Reconcile"
            help="Check the balance here against a statement or the bank's website, and find what differs."
            onClick={onReconcile}
          />
        )}
        {ledger && (
          <Action
            label="Import a CSV"
            help="Transactions from a file your bank's website exports."
            onClick={onImport}
          />
        )}
        {credit && (
          <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <CashbackSection account={a} />
          </div>
        )}
        {a.isManual ? (
          <Action
            label="Delete this account"
            help="Removes it and all of its transactions from this app."
            onClick={onDelete}
            danger
          />
        ) : (
          <p className="text-slate-500 dark:text-slate-400">
            To stop counting it, hide it. To remove a bank&apos;s accounts, disconnect the bank
            under Bank connections.
          </p>
        )}
      </div>
    </Modal>
  );
}

function Action({
  label,
  help,
  onClick,
  danger,
}: {
  label: string;
  help: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="text-slate-500 dark:text-slate-400">{help}</p>
      <button
        type="button"
        onClick={onClick}
        className={`shrink-0 rounded-md border px-3 py-1.5 ${
          danger
            ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            : "border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
        }`}
      >
        {label}
      </button>
    </div>
  );
}
