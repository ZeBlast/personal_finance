import type { ReactNode } from "react";
import {
  confidenceLabel,
  formatCoordinates,
  formatDateTime,
  formatLocation,
  hasBankDetails,
  paymentRows,
} from "../../lib/transactionDetails";
import type { TransactionDetails } from "../../types/api";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

/**
 * Everything else the bank and Plaid sent about a transaction: the time, the bank's own wording,
 * where it happened, the merchant, how it was paid, and how sure Plaid is of its category. Shown
 * only when there is something to show.
 */
export function BankDetails({ details }: { details: TransactionDetails }) {
  if (!hasBankDetails(details)) return null;
  const when = formatDateTime(details.datetime);
  const authorized = formatDateTime(details.authorizedDatetime);
  const coordinates = details.location
    ? formatCoordinates(details.location.lat, details.location.lon)
    : null;
  const payment = paymentRows(details.payment);
  const confidence = confidenceLabel(details.categoryConfidence);

  return (
    <details className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <summary className="cursor-pointer text-sm font-medium">More from your bank</summary>
      <dl className="mt-3 space-y-1">
        {when && <Row label="Time">{when}</Row>}
        {authorized && authorized !== when && <Row label="Authorized">{authorized}</Row>}
        {details.originalDescription && (
          <Row label="Original text">
            <code className="text-xs">{details.originalDescription}</code>
          </Row>
        )}
        {details.location && (
          <Row label="Location">
            {formatLocation(details.location) || "Not given"}
            {details.location.storeNumber && (
              <span className="text-slate-500"> · store {details.location.storeNumber}</span>
            )}
            {coordinates && <div className="text-xs text-slate-500">{coordinates}</div>}
          </Row>
        )}
        {details.merchant?.website && <Row label="Website">{details.merchant.website}</Row>}
        {details.merchant?.categoryCode && (
          <Row label="Merchant code">
            <span title="The card networks' merchant category code (MCC)">
              {details.merchant.categoryCode}
            </span>
          </Row>
        )}
        {details.merchant?.entityId && (
          <Row label="Merchant ID">
            <span className="text-xs text-slate-500">{details.merchant.entityId}</span>
          </Row>
        )}
        {confidence && <Row label="Category confidence">{confidence}</Row>}
        {payment.map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
        {details.counterparties.map((c, index) => (
          <Row key={`${c.name}-${index}`} label={index === 0 ? "Counterparties" : ""}>
            {c.name}
            <span className="text-slate-500">
              {" "}
              ({c.type.replace(/_/g, " ")}
              {c.confidenceLevel ? `, ${confidenceLabel(c.confidenceLevel)?.toLowerCase()}` : ""})
            </span>
            {c.website && <span className="text-slate-500"> · {c.website}</span>}
          </Row>
        ))}
      </dl>
    </details>
  );
}
