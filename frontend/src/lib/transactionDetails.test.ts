import { describe, expect, it } from "vitest";
import type { TransactionDetails } from "../types/api";
import {
  confidenceLabel,
  formatCoordinates,
  formatLocation,
  hasBankDetails,
  paymentRows,
} from "./transactionDetails";

const none: TransactionDetails = {
  datetime: null,
  authorizedDatetime: null,
  originalDescription: null,
  location: null,
  merchant: null,
  categoryConfidence: null,
  payment: null,
  counterparties: [],
};

describe("transaction details", () => {
  it("writes a location on one line, skipping what is missing", () => {
    expect(
      formatLocation({
        address: "100 Main St",
        city: "Springfield",
        region: "IL",
        postalCode: "62701",
        country: "US",
        lat: null,
        lon: null,
        storeNumber: null,
      }),
    ).toBe("100 Main St, Springfield, IL 62701, US");
    expect(
      formatLocation({
        address: null,
        city: "Paris",
        region: null,
        postalCode: null,
        country: "FR",
        lat: null,
        lon: null,
        storeNumber: null,
      }),
    ).toBe("Paris, FR");
  });

  it("rounds coordinates, and says nothing without both", () => {
    expect(formatCoordinates(39.78171, -89.65012)).toBe("39.7817, -89.6501");
    expect(formatCoordinates(39.7, null)).toBeNull();
  });

  it("puts confidence in words and passes an unknown level through", () => {
    expect(confidenceLabel("VERY_HIGH")).toBe("Very high");
    expect(confidenceLabel("LOW")).toBe("Low");
    expect(confidenceLabel(null)).toBeNull();
    expect(confidenceLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("lists only the payment details that were sent", () => {
    expect(paymentRows(null)).toEqual([]);
    expect(
      paymentRows({
        method: "ACH",
        processor: null,
        reference: "R1",
        reason: "",
        byOrderOf: null,
        ppdId: null,
      }),
    ).toEqual([
      ["Payment method", "ACH"],
      ["Reference", "R1"],
    ]);
  });

  it("knows when there is nothing beyond the basics", () => {
    expect(hasBankDetails(none)).toBe(false);
    expect(hasBankDetails({ ...none, originalDescription: "RAW" })).toBe(true);
    expect(
      hasBankDetails({
        ...none,
        counterparties: [
          {
            name: "x",
            type: "merchant",
            entityId: null,
            website: null,
            logoUrl: null,
            confidenceLevel: null,
          },
        ],
      }),
    ).toBe(true);
  });
});
