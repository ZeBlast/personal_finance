export type CsvCell = string | number | boolean | null;

/** Text a spreadsheet would run as a formula if it started with one of these characters. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Writes rows as CSV (RFC 4180: quotes doubled, fields with commas, quotes or line breaks quoted,
 * CRLF line ends). Text that starts with =, +, -, @, a tab or a carriage return is prefixed with
 * an apostrophe so a spreadsheet shows it as text instead of running it as a formula; numbers are
 * passed as numbers and never altered.
 */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  const cell = (value: CsvCell): string => {
    if (value === null) return "";
    let text = typeof value === "string" ? value : String(value);
    if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
