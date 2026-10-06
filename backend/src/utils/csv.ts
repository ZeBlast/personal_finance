/**
 * A small CSV reader: quoted fields (with "" for a quote and line breaks inside quotes), CRLF or
 * LF line ends, an optional byte-order mark, and blank lines skipped. Returns rows of text cells.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let sawContent = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const endRow = (): void => {
    endCell();
    if (sawContent) rows.push(row);
    row = [];
    sawContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (char === ",") {
      endCell();
      sawContent = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += char;
      if (char !== " " && char !== "\t") sawContent = true;
    }
  }
  if (inQuotes) throw new Error("A quoted value is never closed.");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Reads a number as people write it in spreadsheets: `$1,234.50`, `(12.5)` for negative, `-3`,
 * `12%` is NOT accepted. Returns null for an empty cell and throws for anything else unreadable.
 */
export function parseNumberCell(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const negative = /^\(.*\)$/.test(text);
  const digits = text.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(digits)) throw new Error(`"${raw.trim()}" is not a number.`);
  const value = Number(digits);
  return negative ? -Math.abs(value) : value;
}
