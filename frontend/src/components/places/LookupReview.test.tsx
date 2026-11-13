// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Place } from "../../lib/places";
import type { Lookup, PlacePurchase } from "../../types/places";
import { LookupReview, type LookupHandlers } from "./LookupReview";
import { PlaceDetail } from "./PlaceDetail";

afterEach(cleanup);

const lookup = (over: Partial<Lookup>): Lookup => ({
  key: "street=100 main st",
  shop: "Corner Cafe",
  asked: "100 Main St, Springfield, IL 62701",
  found: "100, Main Street, Springfield, Illinois",
  precision: "address",
  lat: 39.8,
  lon: -89.64,
  lookedUpAt: "2026-11-01T10:00:00.000Z",
  purchases: 2,
  verdict: null,
  canMove: true,
  ...over,
});

const lookups = [
  lookup({}),
  lookup({
    key: "postalcode=62701",
    shop: null,
    asked: "Postal code 62701",
    found: "62701, Springfield",
    precision: "postcode",
    purchases: 1,
    canMove: false,
  }),
  lookup({
    key: "q=taco truck",
    shop: "Taco Truck",
    asked: "Taco Truck, Springfield, IL",
    found: null,
    precision: "shop",
    lat: null,
    lon: null,
    purchases: 1,
  }),
  lookup({ key: "street=9 elm ave", asked: "9 Elm Ave, Springfield, IL", verdict: "wrong" }),
];

function handlers() {
  return {
    busy: false,
    onVerdict: vi.fn<LookupHandlers["onVerdict"]>(),
    onMove: vi.fn<LookupHandlers["onMove"]>(),
    onUndo: vi.fn<LookupHandlers["onUndo"]>(),
    onShow: vi.fn<(lookup: Lookup) => void>(),
    onClose: vi.fn<() => void>(),
  };
}

describe("the list of looked-up positions", () => {
  it("lists those to check, the approximate one first, with what was found", () => {
    render(<LookupReview lookups={lookups} shownKey={null} {...handlers()} />);
    expect(screen.getByRole("tab", { name: "To check (2)" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Postal code 62701.*Postal code \(approximate\)/);
    expect(rows[1]!.textContent).toMatch(
      /Corner Cafe · 100 Main St.*Found: 100, Main Street.*Address · 2 purchases/,
    );
    // A postal code is shared by everything in it, so it cannot be moved.
    expect(within(rows[0]!).queryByRole("button", { name: "Move" })).toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: "Move" })).toBeTruthy();
  });

  it("passes on right, wrong, move and showing on the map", async () => {
    const h = handlers();
    render(<LookupReview lookups={lookups} shownKey={null} {...h} />);
    const row = screen.getAllByRole("listitem")[1]!;
    await userEvent.click(within(row).getByRole("button", { name: "Right" }));
    expect(h.onVerdict).toHaveBeenCalledWith(lookups[0], "right");
    await userEvent.click(within(row).getByRole("button", { name: "Wrong" }));
    expect(h.onVerdict).toHaveBeenCalledWith(lookups[0], "wrong");
    await userEvent.click(within(row).getByRole("button", { name: "Move" }));
    expect(h.onMove).toHaveBeenCalledWith("street=100 main st", "Corner Cafe");
    await userEvent.click(within(row).getByTitle("Show on the map"));
    expect(h.onShow).toHaveBeenCalledWith(lookups[0]);
  });

  it("offers to set a position where nothing was found, and to undo a call", async () => {
    const h = handlers();
    render(<LookupReview lookups={lookups} shownKey={null} {...h} />);
    await userEvent.click(screen.getByRole("tab", { name: "Found nothing (1)" }));
    const missing = screen.getByRole("listitem");
    expect(missing.textContent).toMatch(/Found nothing/);
    expect(within(missing).queryByRole("button", { name: "Right" })).toBeNull();
    await userEvent.click(within(missing).getByRole("button", { name: "Set position" }));
    expect(h.onMove).toHaveBeenCalledWith("q=taco truck", "Taco Truck");

    await userEvent.click(screen.getByRole("tab", { name: "Checked (1)" }));
    const judged = screen.getByRole("listitem");
    expect(judged.textContent).toMatch(/You said this is wrong/);
    expect(within(judged).queryByRole("button", { name: "Wrong" })).toBeNull();
    await userEvent.click(within(judged).getByRole("button", { name: "Undo" }));
    expect(h.onUndo).toHaveBeenCalledWith(lookups[3]);
  });
});

describe("a place put on the map by a lookup", () => {
  const place: Place = {
    key: "taco truck@39.790,-89.650",
    merchant: "Taco Truck",
    lat: 39.79,
    lon: -89.65,
    city: "Springfield",
    totalMinor: 1000,
    visits: 1,
    months: ["2026-10"],
    firstDate: "2026-10-01",
    lastDate: "2026-10-01",
    approx: true,
  };
  const purchase: PlacePurchase = {
    id: 7,
    accountId: 1,
    date: "2026-10-01",
    datetime: null,
    merchant: "Taco Truck",
    amountMinor: 1000,
    category: "Dining",
    lat: 39.79,
    lon: -89.65,
    approx: true,
    online: false,
    city: "Springfield",
    lookupKey: "postalcode=62701",
    moveKey: "q=taco truck",
  };
  const panel = (lookup: Lookup | null, h?: LookupHandlers) =>
    render(
      <MemoryRouter>
        <PlaceDetail
          place={place}
          purchases={[purchase]}
          money={(n) => `$${n / 100}`}
          onClose={() => {}}
          lookup={lookup}
          review={h}
        />
      </MemoryRouter>,
    );

  it("says what the lookup found, and moves the shop itself, not its postal code", async () => {
    const h = handlers();
    panel(lookups[1]!, h);
    expect(
      screen.getByText(/Placed by an address lookup\. Found: 62701, Springfield/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Wrong" }));
    expect(h.onVerdict).toHaveBeenCalledWith(lookups[1], "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(h.onMove).toHaveBeenCalledWith("q=taco truck", "Taco Truck");
  });

  it("says nothing of lookups for a place the bank placed", () => {
    panel(null, handlers());
    expect(screen.queryByText(/address lookup/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
  });
});
