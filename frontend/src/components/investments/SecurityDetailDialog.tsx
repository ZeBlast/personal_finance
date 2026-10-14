import { useApi } from "../../hooks/useApi";
import { formatMinor, formatQuantity } from "../../lib/money";
import { securityFacts, taxLotsOf } from "../../lib/securityFacts";
import { formatDay } from "../../lib/time";
import type { InvestmentTransactionDetail, SecurityDetail } from "../../types/investments";
import { Modal } from "../common/Modal";
import { buttonClass } from "./styles";

const money = (n: number) => formatMinor(n, "USD");
const dollars = (n: number | null) =>
  n === null
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[11rem_1fr] gap-2">
          <dt className="text-slate-500">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The provider's complete record, for anyone who wants every field, collapsed by default. */
function RawRecord({ title, raw }: { title: string; raw: unknown }) {
  if (raw === null || raw === undefined) return null;
  return (
    <details className="rounded border border-slate-200 p-2 text-xs dark:border-slate-700">
      <summary className="cursor-pointer text-sm text-blue-700 dark:text-blue-400">{title}</summary>
      <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-100 p-2 dark:bg-slate-900">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </details>
  );
}

/** Everything stored about a fund or stock, and about each place it is held. */
export function SecurityDetailDialog({
  securityId,
  title,
  onClose,
}: {
  securityId: number;
  title: string;
  onClose: () => void;
}) {
  const { data, error, loading } = useApi<SecurityDetail>(`/investments/securities/${securityId}`);
  return (
    <Modal title={title} onClose={onClose} wide dismissible>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && (
        <div className="space-y-4">
          {securityFacts(data.security).map((group) => (
            <section key={group.title}>
              <h3 className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                {group.title}
              </h3>
              <Facts rows={group.rows} />
            </section>
          ))}

          <section>
            <h3 className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
              Where it is held
            </h3>
            {data.positions.length === 0 ? (
              <p className="text-sm text-slate-500">Not currently held in any account.</p>
            ) : (
              <ul className="space-y-3">
                {data.positions.map((p) => {
                  const lots = taxLotsOf(p.raw);
                  return (
                    <li
                      key={p.holdingId}
                      className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700"
                    >
                      <div className="font-medium">{p.accountName}</div>
                      <Facts
                        rows={[
                          ["Quantity", formatQuantity(p.quantity)],
                          [
                            "Price",
                            p.price === null
                              ? "—"
                              : `${dollars(p.price)}${p.priceAsOf ? ` (as of ${formatDay(p.priceAsOf)})` : ""}`,
                          ],
                          ["Value", money(p.valueMinor)],
                          [
                            "Cost",
                            p.costBasisMinor === null ? "not known" : money(p.costBasisMinor),
                          ],
                          ...(p.vestedQuantity !== null || p.vestedValueMinor !== null
                            ? ([
                                [
                                  "Vested",
                                  [
                                    p.vestedQuantity !== null
                                      ? `${formatQuantity(p.vestedQuantity)} shares`
                                      : null,
                                    p.vestedValueMinor !== null ? money(p.vestedValueMinor) : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · "),
                                ],
                              ] as Array<[string, string]>)
                            : []),
                          ["Figures as of", formatDay(p.asOf.slice(0, 10))],
                          ...(p.priceDatetime
                            ? ([["Price time", p.priceDatetime]] as Array<[string, string]>)
                            : []),
                        ]}
                      />
                      {lots.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <caption className="pb-1 text-left text-slate-500">Tax lots</caption>
                            <thead>
                              <tr className="text-left text-slate-500">
                                <th scope="col" className="pr-2 font-medium">
                                  Lot
                                </th>
                                <th scope="col" className="pr-2 font-medium">
                                  Bought
                                </th>
                                <th scope="col" className="pr-2 text-right font-medium">
                                  Shares
                                </th>
                                <th scope="col" className="pr-2 text-right font-medium">
                                  Price
                                </th>
                                <th scope="col" className="pr-2 text-right font-medium">
                                  Cost
                                </th>
                                <th scope="col" className="text-right font-medium">
                                  Value now
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {lots.map((lot, i) => (
                                <tr
                                  key={lot.id ?? i}
                                  className="border-t border-slate-100 dark:border-slate-700"
                                >
                                  <td className="pr-2">{lot.id ?? "—"}</td>
                                  <td className="pr-2">{lot.purchased ?? "—"}</td>
                                  <td className="pr-2 text-right tabular-nums">
                                    {lot.quantity === null ? "—" : formatQuantity(lot.quantity)}
                                  </td>
                                  <td className="pr-2 text-right tabular-nums">
                                    {dollars(lot.purchasePrice)}
                                  </td>
                                  <td className="pr-2 text-right tabular-nums">
                                    {dollars(lot.costBasis)}
                                  </td>
                                  <td className="text-right tabular-nums">
                                    {dollars(lot.currentValue)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <RawRecord
                        title="Everything your institution sent for this holding"
                        raw={p.raw}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {data.raw === null ? (
            <p className="text-xs text-slate-500">
              {data.security["isManual"]
                ? "This security was entered by hand, so there is no record from an institution."
                : "Your institution did not send a complete record for this security."}
            </p>
          ) : (
            <RawRecord title="Everything your institution sent for this security" raw={data.raw} />
          )}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** One investment transaction with every stored field and the provider's own record. */
export function InvestmentTransactionDialog({
  transactionId,
  onClose,
}: {
  transactionId: number;
  onClose: () => void;
}) {
  const { data, error, loading } = useApi<InvestmentTransactionDetail>(
    `/investments/transactions/${transactionId}`,
  );
  return (
    <Modal title="Investment transaction" onClose={onClose} wide dismissible>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && (
        <div className="space-y-3">
          <Facts
            rows={[
              ["Date", formatDay(data.date)],
              ...(data.transactionDatetime
                ? ([["Time", data.transactionDatetime]] as Array<[string, string]>)
                : []),
              ["Type", data.type],
              ...(data.subtype ? ([["Subtype", data.subtype]] as Array<[string, string]>) : []),
              ["Description", data.name],
              ...(data.symbol ? ([["Security", data.symbol]] as Array<[string, string]>) : []),
              ...(data.quantity !== null
                ? ([["Quantity", formatQuantity(data.quantity)]] as Array<[string, string]>)
                : []),
              ...(data.price !== null
                ? ([["Price", dollars(data.price)]] as Array<[string, string]>)
                : []),
              [
                "Cash",
                `${data.amountMinor <= 0 ? "+" : "−"}${money(Math.abs(data.amountMinor))} (${data.amountMinor <= 0 ? "money in" : "money out"})`,
              ],
              ...(data.feesMinor !== null
                ? ([["Fees", money(data.feesMinor)]] as Array<[string, string]>)
                : []),
              ["Account", data.accountName ?? ""],
              [
                "Source",
                data.source === "manual" ? "Entered by hand" : "Reported by your institution",
              ],
            ]}
          />
          {data.raw === null ? (
            <p className="text-xs text-slate-500">
              {data.source === "manual"
                ? "Entered by hand, so there is no record from an institution."
                : "Your institution did not send a complete record for this transaction."}
            </p>
          ) : (
            <RawRecord
              title="Everything your institution sent for this transaction"
              raw={data.raw}
            />
          )}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
