import type { TransactionDetails } from "../types/api";

/** The place a transaction happened, on one line: "100 Main St, Springfield, IL 62701, US". */
export function formatLocation(location: NonNullable<TransactionDetails["location"]>): string {
  const regionAndPostal = [location.region, location.postalCode].filter(Boolean).join(" ");
  return [location.address, location.city, regionAndPostal || null, location.country]
    .filter((part): part is string => !!part)
    .join(", ");
}

/** Plaid's confidence levels, in words. */
export function confidenceLabel(level: string | null): string | null {
  switch (level) {
    case "VERY_HIGH":
      return "Very high";
    case "HIGH":
      return "High";
    case "MEDIUM":
      return "Medium";
    case "LOW":
      return "Low";
    case "UNKNOWN":
      return "Unknown";
    default:
      return level;
  }
}

/** Latitude and longitude, rounded to four places (about 10 metres). */
export function formatCoordinates(lat: number | null, lon: number | null): string | null {
  return lat === null || lon === null ? null : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** The labelled payment details that were actually sent. */
export function paymentRows(payment: TransactionDetails["payment"]): Array<[string, string]> {
  if (!payment) return [];
  const rows: Array<[string, string | null]> = [
    ["Payment method", payment.method],
    ["Processor", payment.processor],
    ["Reference", payment.reference],
    ["Reason", payment.reason],
    ["By order of", payment.byOrderOf],
    ["PPD ID", payment.ppdId],
  ];
  return rows.filter((row): row is [string, string] => row[1] !== null && row[1] !== "");
}

/** A time such as "2026-09-01T14:30:00Z" in the reader's own time zone; the text itself if it is not a time. */
export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Whether there is anything beyond the basics worth showing. */
export function hasBankDetails(d: TransactionDetails): boolean {
  return (
    d.datetime !== null ||
    d.authorizedDatetime !== null ||
    d.originalDescription !== null ||
    d.location !== null ||
    d.merchant !== null ||
    d.categoryConfidence !== null ||
    d.payment !== null ||
    d.counterparties.length > 0
  );
}
