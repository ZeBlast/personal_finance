import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { parseMoneyToMinor } from "../../lib/money";
import type { Account } from "../../types/api";
import { Modal } from "../common/Modal";

/**
 * Records a payment on a loan kept by hand in one step: it lowers what is owed, and when it was
 * paid from an account also kept by hand, the money leaving that account is entered too and the
 * two are linked as one transfer (so it is neither spending nor income). A payment from a
 * connected bank shows up there on its own; link the two from the transaction later.
 */
export function LoanPaymentDialog({
  loan,
  accounts,
  onDone,
  onClose,
}: {
  loan: Account;
  accounts: Account[];
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only accounts kept by hand can have the other side entered here.
  const sources = accounts.filter((a) => a.isManual && a.type === "depository" && !a.hidden);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const amountMinor = parseMoneyToMinor(amount, loan.currency || "USD");
    if (amountMinor === null || amountMinor <= 0) {
      setError("Enter how much was paid, such as 350.00.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const paid = await api<{ id: number }>("/transactions", {
        method: "POST",
        body: JSON.stringify({
          accountId: loan.id,
          date,
          merchant: "Payment",
          amountMinor,
          direction: "in",
          isTransfer: true,
        }),
      });
      const source = sources.find((a) => String(a.id) === from);
      if (source) {
        const out = await api<{ id: number }>("/transactions", {
          method: "POST",
          body: JSON.stringify({
            accountId: source.id,
            date,
            merchant: `Payment to ${loan.name}`.slice(0, 200),
            amountMinor,
            direction: "out",
            isTransfer: true,
          }),
        });
        await api(`/transactions/${paid.id}/transfer-pair`, {
          method: "POST",
          body: JSON.stringify({ otherId: out.id }),
        });
      }
      onDone(
        source
          ? `Recorded the payment to ${loan.name} from ${source.name}.`
          : `Recorded the payment to ${loan.name}.`,
      );
    } catch (err) {
      setError(errorMessage(err, "Could not record the payment."));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";
  return (
    <Modal title={`Record a payment to ${loan.name}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <label className="block" htmlFor={`${id}-amount`}>
          <span className="font-medium">Amount paid</span>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="350.00"
            className={field}
            autoFocus
          />
        </label>
        <label className="block" htmlFor={`${id}-date`}>
          <span className="font-medium">Date</span>
          <input
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </label>
        <label className="block" htmlFor={`${id}-from`}>
          <span className="font-medium">Paid from</span>
          <select
            id={`${id}-from`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={field}
          >
            <option value="">A connected bank (its own transaction will show up)</option>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} (kept by hand: enter it there too)
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 dark:border-slate-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? "Recording..." : "Record payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
