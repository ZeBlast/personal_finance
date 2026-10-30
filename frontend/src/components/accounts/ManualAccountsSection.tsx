import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { parseMoneyToMinor } from "../../lib/money";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { Select } from "../common/Select";

type Kind =
  | "cash"
  | "checking"
  | "savings"
  | "credit_card"
  | "loan"
  | "store_credit"
  | "pokemon_cards"
  | "collection";

const KINDS: Array<{ value: Kind; label: string; balanceLabel: string; help: string }> = [
  {
    value: "cash",
    label: "Cash (wallet, jar, envelope)",
    balanceLabel: "Cash on hand right now",
    help: "Track cash you spend and receive. The balance is worked out from your transactions.",
  },
  {
    value: "checking",
    label: "Checking account",
    balanceLabel: "Current balance",
    help: "For an account at a bank that cannot be connected automatically.",
  },
  {
    value: "savings",
    label: "Savings account",
    balanceLabel: "Current balance",
    help: "For an account at a bank that cannot be connected automatically.",
  },
  {
    value: "credit_card",
    label: "Credit card",
    balanceLabel: "Amount owed right now",
    help: "Purchases raise what you owe; payments lower it.",
  },
  {
    value: "loan",
    label: "Loan (car, student, personal)",
    balanceLabel: "Amount owed right now",
    help: "For a lender that cannot be connected. Interest and fees raise what you owe; payments lower it. Add its interest rate on the Debt payoff page to see when it will be paid off.",
  },
  {
    value: "store_credit",
    label: "Gift card / store credit",
    balanceLabel: "Credit on it right now",
    help: "Dollar credits with one business, such as a Dunkin gift card. Add credits, then record purchases paid with them, alone or with real money. Credits only count in this account: never in income, spending, or net worth.",
  },
  {
    value: "pokemon_cards",
    label: "Pokémon cards (collection)",
    balanceLabel: "",
    help: "Pokémon cards, each with its TCGplayer id and condition (Lightly Played unless you say otherwise). Import a TCGplayer export or add cards, and get market prices from JustTCG. The account is worth the total, which counts in net worth.",
  },
  {
    value: "collection",
    label: "Other collection (coins, stamps, collectibles)",
    balanceLabel: "",
    help: "Collectibles you value yourself. Add items, or import a TCGplayer export, and enter what each is worth. The account is worth the total, which counts in net worth.",
  },
];

export function NewAccountDialog({
  onCreated,
  onClose,
}: {
  onCreated: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("cash");
  const [balance, setBalance] = useState("");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = KINDS.find((k) => k.value === kind)!;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the account a name.");
      return;
    }
    const opening =
      balance.trim() === "" ? 0 : parseMoneyToMinor(balance, "USD", { allowZero: true });
    if (opening === null) {
      setError("Enter the starting amount in dollars, for example 250.00, or leave it empty.");
      return;
    }
    const limitMinor = limit.trim() === "" ? undefined : parseMoneyToMinor(limit, "USD");
    if (limit.trim() !== "" && limitMinor === null) {
      setError("Enter the credit limit in dollars, for example 5000.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/accounts/manual", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind,
          ...(opening !== 0 ? { openingBalanceMinor: opening } : {}),
          ...(kind === "credit_card" && limitMinor ? { creditLimitMinor: limitMinor } : {}),
        }),
      });
      onCreated(`${name.trim()} was created.`);
    } catch (e) {
      setError(errorMessage(e, "Could not create the account."));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an account by hand" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div>
          <label htmlFor={`${id}-kind`} className="block font-medium">
            Type
          </label>
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className={inputClass}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-slate-500">{info.help}</p>
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="block font-medium">
            Name
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === "cash"
                ? "Wallet"
                : kind === "store_credit"
                  ? "Dunkin"
                  : kind === "pokemon_cards"
                    ? "Pokémon cards"
                    : kind === "collection"
                      ? "Coins"
                      : "My account"
            }
            className={inputClass}
          />
        </div>
        {kind !== "collection" && kind !== "pokemon_cards" && (
          <div>
            <label htmlFor={`${id}-balance`} className="block font-medium">
              {info.balanceLabel} (optional)
            </label>
            <input
              id={`${id}-balance`}
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder="0.00"
              className={inputClass}
            />
          </div>
        )}
        {kind === "credit_card" && (
          <div>
            <label htmlFor={`${id}-limit`} className="block font-medium">
              Credit limit (optional)
            </label>
            <input
              id={`${id}-limit`}
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
