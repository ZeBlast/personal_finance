import { describe, expect, it } from "vitest";
import { evaluate, myNumbersTemplate } from "./graph";

describe("starting the sandbox from my numbers", () => {
  it("is income less the biggest categories and everything else", () => {
    const graph = myNumbersTemplate({
      categories: [
        { name: "Rent", monthly: 1_500 },
        { name: "Groceries", monthly: 400 },
        ...["A", "B", "C", "D", "E"].map((name) => ({ name, monthly: 10 })),
      ],
      totalMonthly: 2_000,
      months: 6,
    });
    const titles = graph.nodes.filter((n) => n.kind === "expense").map((n) => n.title);
    // Six categories of their own, the seventh folded into "Everything else".
    expect(titles).toEqual(["Rent", "Groceries", "A", "B", "C", "D", "Everything else"]);
    const result = evaluate(graph, { "income:6": 36_000 });
    // $36,000 a year in, $2,000 a month out: $12,000 left over.
    expect(result.outputs["left"]?.["result"]).toBeCloseTo(12_000, 6);
  });
});
