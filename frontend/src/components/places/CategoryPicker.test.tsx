// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryPicker, pickedLabel } from "./CategoryPicker";

afterEach(cleanup);

const categories = [
  { name: "Groceries", count: 12 },
  { name: "Dining", count: 5 },
  { name: "Uncategorized", count: 1 },
];

function Harness() {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return <CategoryPicker categories={categories} picked={picked} onChange={setPicked} />;
}

describe("the map's category picker", () => {
  it("names what is picked", () => {
    expect(pickedLabel(new Set())).toBe("All categories");
    expect(pickedLabel(new Set(["Dining"]))).toBe("Dining");
    expect(pickedLabel(new Set(["Dining", "Groceries"]))).toBe("2 categories");
  });

  it("ticks several categories, and goes back to all of them", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole("button", { name: /Categories on the map: All categories/ });
    await user.click(button);
    await user.click(screen.getByRole("checkbox", { name: /Groceries/ }));
    await user.click(screen.getByRole("checkbox", { name: /Dining/ }));
    expect(button.textContent).toBe("2 categories");
    await user.click(screen.getByRole("checkbox", { name: /Dining/ }));
    expect(button.textContent).toBe("Groceries");
    await user.click(screen.getByRole("button", { name: "All categories" }));
    expect(button.textContent).toBe("All categories");
    // Esc puts the list away.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
