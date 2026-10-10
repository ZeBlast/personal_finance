import { parseDecimal, parseMoneyToMinor } from "../../lib/money";
import type { FundPresets, HoldingRow } from "../../types/investments";

/** What the holdings form keeps for one row: everything is text until the form is submitted. */
export interface HoldingDraft {
  /** Stable key for React lists. */
  key: number;
  /** A preset fund's symbol, or "" when the row is a custom fund. */
  preset: string;
  symbol: string;
  name: string;
  assetClass: string;
  quantity: string;
  price: string;
  value: string;
  cost: string;
  // Optional details. For a retirement plan these are the vested part and the fund's identifiers.
  vestedQuantity: string;
  vestedValue: string;
  priceAsOf: string;
  isin: string;
  cusip: string;
  sector: string;
  industry: string;
  subtype: string;
}

export interface HoldingPayload {
  symbol?: string;
  name?: string;
  assetClass?: string;
  quantity: number;
  price?: number;
  valueMinor?: number;
  costBasisMinor?: number;
  vestedQuantity?: number;
  vestedValueMinor?: number;
  priceAsOf?: string;
  detail?: Record<string, string>;
}

let nextKey = 1;

export function emptyDraft(): HoldingDraft {
  return {
    key: nextKey++,
    preset: "",
    symbol: "",
    name: "",
    assetClass: "Funds",
    quantity: "",
    price: "",
    value: "",
    cost: "",
    vestedQuantity: "",
    vestedValue: "",
    priceAsOf: "",
    isin: "",
    cusip: "",
    sector: "",
    industry: "",
    subtype: "",
  };
}

const plain = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** A form row for a holding the account already has. */
export function draftFromHolding(holding: HoldingRow, presets: FundPresets): HoldingDraft {
  const preset = presets.funds.find((f) => f.symbol === holding.symbol);
  return {
    ...emptyDraft(),
    preset: preset?.symbol ?? "",
    symbol: preset ? "" : (holding.symbol ?? ""),
    name: preset ? "" : holding.name,
    assetClass: holding.assetClass,
    quantity: String(holding.quantity),
    price: holding.price === null ? "" : plain(holding.price, 6),
    value: (holding.valueMinor / 100).toFixed(2),
    cost: holding.costBasisMinor === null ? "" : (holding.costBasisMinor / 100).toFixed(2),
    // Saving replaces the holding, so what it already records must travel with the form.
    vestedQuantity: holding.vestedQuantity === null ? "" : String(holding.vestedQuantity),
    vestedValue:
      holding.vestedValueMinor === null ? "" : (holding.vestedValueMinor / 100).toFixed(2),
    priceAsOf: holding.priceAsOf ?? "",
  };
}

export type DraftResult = { ok: true; payload: HoldingPayload[] } | { ok: false; message: string };

/** Checks every row and builds what the server expects, or says which row is wrong and why. */
export function buildPayload(drafts: HoldingDraft[], presets: FundPresets): DraftResult {
  const payload: HoldingPayload[] = [];
  for (const [index, d] of drafts.entries()) {
    const row = `Holding ${index + 1}`;
    const preset = presets.funds.find((f) => f.symbol === d.preset);
    if (!preset && d.symbol.trim() === "" && d.name.trim() === "") {
      return { ok: false, message: `${row}: choose a fund, or type a name for it.` };
    }
    const quantity = parseDecimal(d.quantity);
    if (quantity === null) {
      return {
        ok: false,
        message: `${row}: enter the number of shares or units (for example 120.5).`,
      };
    }
    const price = d.price.trim() === "" ? null : parseDecimal(d.price);
    if (d.price.trim() !== "" && price === null) {
      return { ok: false, message: `${row}: the price must be a number, for example 98.1234.` };
    }
    const value =
      d.value.trim() === "" ? null : parseMoneyToMinor(d.value, "USD", { allowZero: true });
    if (d.value.trim() !== "" && value === null) {
      return { ok: false, message: `${row}: enter the value as dollars, for example 2500.00.` };
    }
    if (value === null && price === null) {
      return { ok: false, message: `${row}: enter the total value, or a price per share.` };
    }
    const cost =
      d.cost.trim() === "" ? null : parseMoneyToMinor(d.cost, "USD", { allowZero: true });
    if (d.cost.trim() !== "" && cost === null) {
      return {
        ok: false,
        message: `${row}: enter the cost as dollars, or leave it blank if unknown.`,
      };
    }
    const vestedQuantity = d.vestedQuantity.trim() === "" ? null : parseDecimal(d.vestedQuantity);
    if (d.vestedQuantity.trim() !== "" && (vestedQuantity === null || vestedQuantity > quantity)) {
      return {
        ok: false,
        message: `${row}: the vested shares must be a number no larger than the shares held.`,
      };
    }
    const vestedValue =
      d.vestedValue.trim() === ""
        ? null
        : parseMoneyToMinor(d.vestedValue, "USD", { allowZero: true });
    if (d.vestedValue.trim() !== "" && vestedValue === null) {
      return {
        ok: false,
        message: `${row}: enter the vested value as dollars, for example 2000.00.`,
      };
    }
    if (d.priceAsOf.trim() !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(d.priceAsOf.trim())) {
      return { ok: false, message: `${row}: enter the price date as YYYY-MM-DD.` };
    }
    const detail: Record<string, string> = {};
    if (d.isin.trim()) detail["isin"] = d.isin.trim().toUpperCase();
    if (d.cusip.trim()) detail["cusip"] = d.cusip.trim().toUpperCase();
    if (d.sector.trim()) detail["sector"] = d.sector.trim();
    if (d.industry.trim()) detail["industry"] = d.industry.trim();
    if (d.subtype.trim()) detail["subtype"] = d.subtype.trim();
    payload.push({
      ...(preset
        ? { symbol: preset.symbol }
        : {
            ...(d.symbol.trim() ? { symbol: d.symbol.trim() } : {}),
            ...(d.name.trim() ? { name: d.name.trim() } : {}),
            assetClass: d.assetClass,
          }),
      quantity,
      ...(price !== null ? { price } : {}),
      ...(value !== null ? { valueMinor: value } : {}),
      ...(cost !== null ? { costBasisMinor: cost } : {}),
      ...(vestedQuantity !== null ? { vestedQuantity } : {}),
      ...(vestedValue !== null ? { vestedValueMinor: vestedValue } : {}),
      ...(d.priceAsOf.trim() ? { priceAsOf: d.priceAsOf.trim() } : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  }
  return { ok: true, payload };
}
