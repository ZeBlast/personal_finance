import { useEffect, useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import type { FundPresets, HoldingRow } from "../../types/investments";
import { Modal } from "../common/Modal";
import { buildPayload, draftFromHolding, emptyDraft, type HoldingDraft } from "./holdingsForm";
import { buttonClass, inputClass, primaryClass } from "./styles";

/**
 * Edits everything a manual account holds. Saving replaces the account's holdings with exactly
 * what is listed here, so removing a row removes the holding.
 */
export function HoldingsEditor({
  accountId,
  accountName,
  onSaved,
  onCancel,
}: {
  accountId: number;
  accountName: string;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [presets, setPresets] = useState<FundPresets | null>(null);
  const [rows, setRows] = useState<HoldingDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [fundPresets, current] = await Promise.all([
          api<FundPresets>("/investments/funds"),
          api<HoldingRow[]>(`/investments/holdings?accountId=${accountId}`),
        ]);
        if (cancelled) return;
        setPresets(fundPresets);
        setRows(
          current.length > 0
            ? current.map((h) => draftFromHolding(h, fundPresets))
            : [emptyDraft()],
        );
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, "Could not load this account's holdings."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const update = (key: number, change: Partial<HoldingDraft>): void =>
    setRows((previous) => previous?.map((r) => (r.key === key ? { ...r, ...change } : r)) ?? null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!presets || !rows) return;
    const built = buildPayload(rows, presets);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ totalMinor: number; count: number }>(
        `/investments/accounts/${accountId}/holdings`,
        { method: "PUT", body: JSON.stringify({ holdings: built.payload }) },
      );
      onSaved(`Saved ${result.count} holding${result.count === 1 ? "" : "s"} in ${accountName}.`);
    } catch (e) {
      setError(errorMessage(e, "Could not save the holdings."));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Holdings in ${accountName}`} onClose={onCancel} wide>
      {!presets || !rows ? (
        <p className="text-sm text-slate-500">{error ?? "Loading..."}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4 text-sm">
          <p className="text-slate-600 dark:text-slate-300">
            List what the account holds today. For each, enter the total value, or a price per share
            and the value is worked out. The cost is optional; leave it blank when unknown and no
            gain will be claimed for that holding.
          </p>
          <ul className="space-y-3">
            {rows.map((row, index) => {
              const rowId = `${id}-${row.key}`;
              const custom = row.preset === "";
              return (
                <li
                  key={row.key}
                  className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label htmlFor={`${rowId}-fund`} className="block font-medium">
                        Fund {rows.length > 1 ? index + 1 : ""}
                      </label>
                      <select
                        id={`${rowId}-fund`}
                        value={row.preset}
                        onChange={(e) => update(row.key, { preset: e.target.value })}
                        className={inputClass}
                      >
                        <option value="">Other fund (type its name)</option>
                        {presets.funds.map((f) => (
                          <option key={f.symbol} value={f.symbol}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRows((r) => r?.filter((x) => x.key !== row.key) ?? null)}
                      className={buttonClass}
                      aria-label={`Remove holding ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                  {custom && (
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label htmlFor={`${rowId}-name`} className="block font-medium">
                          Name
                        </label>
                        <input
                          id={`${rowId}-name`}
                          value={row.name}
                          maxLength={120}
                          onChange={(e) => update(row.key, { name: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label htmlFor={`${rowId}-symbol`} className="block font-medium">
                          Symbol (optional)
                        </label>
                        <input
                          id={`${rowId}-symbol`}
                          value={row.symbol}
                          maxLength={40}
                          onChange={(e) => update(row.key, { symbol: e.target.value })}
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label htmlFor={`${rowId}-class`} className="block font-medium">
                          Type
                        </label>
                        <select
                          id={`${rowId}-class`}
                          value={row.assetClass}
                          onChange={(e) => update(row.key, { assetClass: e.target.value })}
                          className={inputClass}
                        >
                          {presets.assetClasses.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <label htmlFor={`${rowId}-qty`} className="block font-medium">
                        Shares
                      </label>
                      <input
                        id={`${rowId}-qty`}
                        inputMode="decimal"
                        value={row.quantity}
                        onChange={(e) => update(row.key, { quantity: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${rowId}-price`} className="block font-medium">
                        Price per share
                      </label>
                      <input
                        id={`${rowId}-price`}
                        inputMode="decimal"
                        value={row.price}
                        onChange={(e) => update(row.key, { price: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${rowId}-value`} className="block font-medium">
                        Total value
                      </label>
                      <input
                        id={`${rowId}-value`}
                        inputMode="decimal"
                        value={row.value}
                        onChange={(e) => update(row.key, { value: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${rowId}-cost`} className="block font-medium">
                        Cost (optional)
                      </label>
                      <input
                        id={`${rowId}-cost`}
                        inputMode="decimal"
                        value={row.cost}
                        onChange={(e) => update(row.key, { cost: e.target.value })}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => setRows((r) => [...(r ?? []), emptyDraft()])}
            className={buttonClass}
          >
            Add another holding
          </button>
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={primaryClass}>
              {busy ? "Saving..." : "Save holdings"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
