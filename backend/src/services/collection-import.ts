/**
 * Reads a TCGPlayer collection export: one line per card, such as
 *
 *   2 Zarude [PBL] 056/084
 *   1 Pikachu ex - 028/131 [PRE] 028/131
 *   1 Professor's Research [Professor Rowan] (Poke Ball Pattern) [PRE] 124/131
 *   1 Vikavolt - 066/217 (Quick Ball) [ASC] 066/217
 *
 * that is: a quantity, the card's name (sometimes with its number repeated after " - ", and a
 * bracketed sub-name), any variants in parentheses, the set code in brackets, and the card number.
 * The same card on several lines (TCGPlayer lists each copy it added separately) becomes one item
 * with the quantities added up.
 */

export interface ParsedCard {
  /** Identifies the same card across lines and imports: name, variant, set, number. */
  key: string;
  name: string;
  /** Printings such as "Poke Ball Pattern" or "Cracked Ice Holo"; empty for the regular card. */
  variant: string;
  setCode: string;
  number: string;
  quantity: number;
}

export interface ParsedExport {
  cards: ParsedCard[];
  /** Lines that were not cards, with their line numbers (blank lines are left out). */
  skipped: Array<{ line: number; text: string }>;
  /** Copies in all, after merging. */
  totalQuantity: number;
}

const LINE = /^(\d+)\s+(.+?)\s+\[([^\]]+)\]\s+(\S+)\s*$/;
/** The card number repeated in the name: " - 058/131", " - 073", " - BW06", " - SM212". */
const REPEATED_NUMBER = /\s+-\s+[A-Z]{0,4}\d+[A-Z]?(\/[A-Z]{0,4}\d+)?(?=\s|$)/g;
const PARENS = /\(([^()]*)\)/g;

export function cardKey(name: string, variant: string, setCode: string, number: string): string {
  return [name, variant, setCode, number].map((p) => p.trim().toLowerCase()).join("|");
}

/** One line as a card, or null when it is not one. */
export function parseCardLine(text: string): ParsedCard | null {
  const m = LINE.exec(text.trim());
  if (!m) return null;
  const quantity = Number(m[1]);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) return null;
  let rest = m[2]!;
  const setCode = m[3]!.trim();
  const number = m[4]!.trim();

  const variants: string[] = [];
  rest = rest.replace(PARENS, (_, inner: string) => {
    const v = inner.trim();
    // "(53)" only tells two printings of a name apart; the card number already does.
    if (v !== "" && !/^\d+$/.test(v)) variants.push(v);
    return " ";
  });
  const name = rest.replace(REPEATED_NUMBER, "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const variant = variants.join(", ");
  return { key: cardKey(name, variant, setCode, number), name, variant, setCode, number, quantity };
}

export function parseCollectionExport(text: string): ParsedExport {
  const byKey = new Map<string, ParsedCard>();
  const skipped: ParsedExport["skipped"] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === "") return;
    const card = parseCardLine(raw);
    if (!card) {
      skipped.push({ line: i + 1, text: raw.trim().slice(0, 200) });
      return;
    }
    const existing = byKey.get(card.key);
    if (existing) existing.quantity += card.quantity;
    else byKey.set(card.key, card);
  });
  const cards = [...byKey.values()];
  return { cards, skipped, totalQuantity: cards.reduce((n, c) => n + c.quantity, 0) };
}
