import { describe, expect, it } from "vitest";
import { linkExitMessage } from "./plaidLinkExit";

describe("why Plaid's window closed", () => {
  it("says nothing when the user just closed it", () => {
    expect(linkExitMessage(null)).toBeNull();
  });

  it("explains common problems in plain words", () => {
    expect(linkExitMessage({ error_code: "INSTITUTION_DOWN" }, "Chase")).toMatch(
      /^Chase is not responding/,
    );
    expect(linkExitMessage({ error_code: "INVALID_CREDENTIALS" })).toMatch(/username or password/);
    expect(linkExitMessage({ error_code: "ITEM_LOCKED" })).toMatch(/locked/);
    expect(linkExitMessage({ error_code: "NO_ACCOUNTS" })).toMatch(/kept by hand/);
    expect(linkExitMessage({ error_code: "ACCOUNTS_RATE_LIMIT" })).toMatch(/busy/);
  });

  it("falls back to Plaid's own message for anything else", () => {
    expect(
      linkExitMessage({ error_code: "SOMETHING_NEW", display_message: "Try again soon." }),
    ).toBe("Try again soon.");
    expect(linkExitMessage({ error_code: "SOMETHING_NEW", error_message: "odd" })).toBe(
      "Plaid stopped: odd",
    );
    expect(linkExitMessage({ error_code: "SOMETHING_NEW" })).toMatch(/closed before/);
  });
});
