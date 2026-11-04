// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HowThisWorks } from "./HowThisWorks";

afterEach(cleanup);

describe("HowThisWorks", () => {
  it("starts closed and opens on a click", async () => {
    render(
      <HowThisWorks>
        <p>Click a card.</p>
      </HowThisWorks>,
    );
    const details = screen.getByText("ⓘ How this works").closest("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("ⓘ How this works"));
    expect(details.open).toBe(true);
    expect(screen.getByText("Click a card.")).toBeTruthy();
  });
});
