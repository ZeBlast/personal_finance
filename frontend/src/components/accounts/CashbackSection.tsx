import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { categoryOptions, useCategories } from "../../hooks/useCategories";
import {
  buildRulesPayload,
  draftsFromRules,
  emptyDraft,
  isBlankDraft,
  RULE_KINDS,
  formatRate,
  type CashbackRule,
  type CashbackSummary,
  type RateDraft,
  type RuleKind,
} from "../../lib/cashback";
import { formatMinor } from "../../lib/money";
import { PERIOD_OPTIONS, resolvePeriod } from "../../lib/period";
import { announceDataChanged } from "../../lib/syncEvents";
import type { Account } from "../../types/api";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { Select } from "../common/Select";

/**
 * A credit card's cashback: the rates it earns (by category, and for everything else) and what it
 * has earned over a period, from its purchases. The earned figure is an estimate of what the card
 * issuer credits, which rounds and caps in its own ways.
 */
export function CashbackSection({ account }: { account: Account }) {
  const [period, setPeriod] = useState("this-month");
  const [editing, setEditing] = useState(false);
  const range = resolvePeriod(period);
  const rules = useApi<CashbackRule[]>(`/accounts/${account.id}/cashback-rules`);
  const summary = useApi<CashbackSummary>(
    `/cashback/summary?from=${range.from}&to=${range.to}&accountId=${account.id}`,
  );
  const card = summary.data?.cards[0];
  const money = (n: number) => formatMinor(n, account.currency);

  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-xs text-slate-500">
        Cashback
        {card && card.hasRates ? ` · ${money(card.cashbackMinor)} ${range.label}` : ""}
        {card && !card.hasRates ? " · set up the rates" : ""}
      </summary>
      <div className="mt-2 space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs">
            Earned
            <Select
              aria-label={`Cashback period for ${account.name}`}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800"
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          {!editing && (
            <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
              {rules.data && rules.data.length > 0 ? "Edit rates" : "Set rates"}
            </button>
          )}
        </div>

        {summary.error && (
          <p role="alert" className="text-red-600">
            {summary.error}
          </p>
        )}

        {card && (
          <div>
            <div className="text-lg font-semibold tabular-nums">{money(card.cashbackMinor)}</div>
            <div className="text-xs text-slate-500">
              on {money(card.spendMinor)} of purchases {range.label}. An estimate of what the card
              credits.
            </div>
            {card.buckets.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th scope="col" className="pb-1 font-medium">
                      Rule
                    </th>
                    <th scope="col" className="pb-1 text-right font-medium">
                      Rate
                    </th>
                    <th scope="col" className="pb-1 text-right font-medium">
                      Spent
                    </th>
                    <th scope="col" className="pb-1 text-right font-medium">
                      Earned
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {card.buckets.map((b) => (
                    <tr
                      key={`${b.categoryId}-${b.label}`}
                      className="border-t border-slate-100 dark:border-slate-700"
                    >
                      <td className="py-1">{b.label}</td>
                      <td className="py-1 text-right tabular-nums">{formatRate(b.rateBps)}</td>
                      <td className="py-1 text-right tabular-nums">{money(b.spendMinor)}</td>
                      <td className="py-1 text-right font-medium tabular-nums">
                        {money(b.cashbackMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {editing && (
          <RatesEditor
            account={account}
            saved={rules.data ?? []}
            onDone={(saved) => {
              setEditing(false);
              if (saved) {
                rules.reload();
                summary.reload();
                announceDataChanged();
              }
            }}
          />
        )}
      </div>
    </details>
  );
}

function RatesEditor({
  account,
  saved,
  onDone,
}: {
  account: Account;
  saved: CashbackRule[];
  onDone: (saved: boolean) => void;
}) {
  const { categories } = useCategories();
  const options = categoryOptions(categories ?? []);
  const [rows, setRows] = useState<RateDraft[]>(() => draftsFromRules(saved));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A card with no rates yet starts with one row to fill in.
  useEffect(() => {
    setRows((r) => (r.length === 0 ? [emptyDraft()] : r));
  }, []);

  const update = (index: number, change: Partial<RateDraft>): void =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function save(): Promise<void> {
    const built = buildRulesPayload(rows.filter((r) => !isBlankDraft(r)));
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/accounts/${account.id}/cashback-rules`, {
        method: "PUT",
        body: JSON.stringify({ rules: built.rules }),
      });
      onDone(true);
    } catch (e) {
      setError(errorMessage(e, "Could not save the rates."));
      setBusy(false);
    }
  }

  const id = (part: string, index: number) => `cb-${part}-${account.id}-${index}`;

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
      <div className="space-y-1 text-xs text-slate-500">
        <p>
          <strong>Category rate:</strong> a purchase uses its own category&apos;s rate, else its
          parent category&apos;s, else the rate for everything else.
        </p>
        <p>
          <strong>Merchant rate:</strong> a merchant whose name contains the text earns this rate,
          whatever its category.
        </p>
        <p>
          <strong>Exclude a merchant:</strong> the merchant earns nothing from the chosen category
          (and those under it), falling back to everything else; choose &quot;Every rate&quot; to
          earn nothing at all. Grocery stores but not Walmart is a Groceries rate plus an exclusion
          of &quot;walmart&quot; from Groceries.
        </p>
        <p>
          <strong>Online only:</strong> the rate applies just to purchases bought online (such as
          Bank of America&apos;s Customized Cash Rewards); an online purchase earns the higher of
          its online and ordinary rates.
        </p>
      </div>
      {rows.map((row, index) => (
        <div
          key={index}
          className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-800"
        >
          <div className="w-44">
            <label className="block text-xs font-medium" htmlFor={id("kind", index)}>
              Rule
            </label>
            <Select
              id={id("kind", index)}
              value={row.kind}
              onChange={(e) => update(index, { kind: e.target.value as RuleKind })}
              className={inputClass}
            >
              {RULE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          {row.kind !== "category" && (
            <div className="min-w-40 flex-1">
              <label className="block text-xs font-medium" htmlFor={id("merchant", index)}>
                Merchant name contains
              </label>
              <input
                id={id("merchant", index)}
                value={row.merchant}
                maxLength={100}
                placeholder="walmart"
                onChange={(e) => update(index, { merchant: e.target.value })}
                className={inputClass}
              />
            </div>
          )}
          {row.kind !== "merchant" && (
            <div className="min-w-40 flex-1">
              <label className="block text-xs font-medium" htmlFor={id("cat", index)}>
                {row.kind === "exclude" ? "Excluded from" : "Category"}
              </label>
              <Select
                id={id("cat", index)}
                value={row.categoryId}
                onChange={(e) => update(index, { categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">
                  {row.kind === "exclude" ? "Every rate" : "Everything else"}
                </option>
                {options.map((o) => (
                  <option key={o.id} value={o.id} data-depth={o.depth}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {row.kind !== "exclude" && (
            <>
              <div className="w-24">
                <label className="block text-xs font-medium" htmlFor={id("rate", index)}>
                  Cashback %
                </label>
                <input
                  id={id("rate", index)}
                  inputMode="decimal"
                  value={row.rate}
                  placeholder="1.5"
                  onChange={(e) => update(index, { rate: e.target.value })}
                  className={inputClass}
                />
              </div>
              <label className="flex items-center gap-1 pb-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={row.onlineOnly}
                  onChange={(e) => update(index, { onlineOnly: e.target.checked })}
                />
                Online only
              </label>
            </>
          )}
          <button
            type="button"
            className={buttonClass}
            aria-label={`Remove rule ${index + 1}`}
            onClick={() => setRows((r) => r.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={() => setRows((r) => [...r, emptyDraft()])}
        >
          Add a rule
        </button>
        <div className="flex-1" />
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="button" className={primaryClass} disabled={busy} onClick={() => void save()}>
          {busy ? "Saving..." : "Save rates"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
