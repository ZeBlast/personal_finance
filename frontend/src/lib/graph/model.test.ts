import { describe, expect, it } from "vitest";
import {
  accountNode,
  buildModel,
  clusterNode,
  DEFAULT_OPTIONS,
  institutionNode,
  neighbours,
  txNode,
  type GraphData,
  type GraphTx,
} from "./model";
import { Simulation } from "./sim";

const tx = (over: Partial<GraphTx>): GraphTx => ({
  id: 1,
  accountId: 10,
  date: "2026-09-01",
  merchant: "Store",
  amountMinor: 1000,
  pending: false,
  categoryId: 5,
  categoryName: "Groceries",
  categoryColor: "#16a34a",
  isTransfer: false,
  transferPairId: null,
  income: false,
  source: null,
  ...over,
});

const data: GraphData = {
  institutions: [
    { id: "item-1", name: "Bank", color: null },
    { id: "manual", name: "Kept by hand", color: null },
  ],
  accounts: [
    {
      id: 10,
      institutionId: "item-1",
      name: "Checking",
      type: "depository",
      subtype: null,
      balanceMinor: 50_000,
      color: "#2563eb",
    },
    {
      id: 11,
      institutionId: "item-1",
      name: "Savings",
      type: "depository",
      subtype: null,
      balanceMinor: 0,
      color: null,
    },
    {
      id: 20,
      institutionId: "manual",
      name: "Wallet",
      type: "depository",
      subtype: null,
      balanceMinor: 0,
      color: null,
    },
  ],
  transactions: [
    tx({ id: 1 }),
    tx({ id: 2, amountMinor: 2500, merchant: "Market" }),
    tx({ id: 3, categoryId: 7, categoryName: "Dining", merchant: "Cafe", amountMinor: 800 }),
    tx({ id: 4, amountMinor: -300_000, income: true, source: "ACME Corp", categoryId: null }),
    // A transfer from Checking to Savings, both sides matched.
    tx({ id: 5, amountMinor: 10_000, isTransfer: true, transferPairId: 6, categoryId: null }),
    tx({
      id: 6,
      accountId: 11,
      amountMinor: -10_000,
      isTransfer: true,
      transferPairId: 5,
      categoryId: null,
    }),
  ],
};

const ids = (m: ReturnType<typeof buildModel>) => m.nodes.map((n) => n.id).sort();

describe("graph model", () => {
  it("links institutions to accounts, accounts to category clusters, income, and transfers", () => {
    const m = buildModel(data);
    expect(ids(m)).toEqual(
      [
        institutionNode("item-1"),
        institutionNode("manual"),
        accountNode(10),
        accountNode(11),
        accountNode(20),
        clusterNode(10, 5),
        clusterNode(10, 7),
        "inc:acme corp",
      ].sort(),
    );
    const groceries = m.nodes.find((n) => n.id === clusterNode(10, 5))!;
    expect(groceries).toMatchObject({
      weightMinor: 3500,
      transactionIds: [1, 2],
      label: "Groceries",
    });
    const link = (kind: string) => m.links.filter((l) => l.kind === kind);
    expect(link("owns")).toHaveLength(3);
    expect(link("income")).toEqual([
      expect.objectContaining({
        source: "inc:acme corp",
        target: accountNode(10),
        weightMinor: 300_000,
      }),
    ]);
    // One line for the pair, from the side the money left.
    expect(link("transfer")).toEqual([
      expect.objectContaining({
        source: accountNode(10),
        target: accountNode(11),
        weightMinor: 10_000,
      }),
    ]);
  });

  it("shows an open cluster's transactions one by one", () => {
    const m = buildModel(data, {
      ...DEFAULT_OPTIONS,
      groupMerchants: false,
      openClusters: new Set([clusterNode(10, 5)]),
    });
    expect(m.nodes.filter((n) => n.kind === "transaction").map((n) => n.id)).toEqual([
      txNode(1),
      txNode(2),
    ]);
    expect(neighbours(m).get(clusterNode(10, 5))).toEqual(
      new Set([accountNode(10), txNode(1), txNode(2)]),
    );
  });

  it("filters by search, and can leave out income, transfers, and idle accounts", () => {
    const found = buildModel(data, { ...DEFAULT_OPTIONS, search: "cafe" });
    expect(ids(found)).toEqual(
      [institutionNode("item-1"), accountNode(10), clusterNode(10, 7)].sort(),
    );
    const quiet = buildModel(data, {
      ...DEFAULT_OPTIONS,
      showIncome: false,
      showTransfers: false,
      hideIdleAccounts: true,
    });
    expect(quiet.links.some((l) => l.kind === "income" || l.kind === "transfer")).toBe(false);
    expect(quiet.nodes.some((n) => n.id === accountNode(20))).toBe(false);
  });
});

describe("hiding spending", () => {
  it("leaves only accounts, transfers, and income", () => {
    const m = buildModel(data, { ...DEFAULT_OPTIONS, showSpending: false });
    expect(m.nodes.some((n) => n.kind === "cluster" || n.kind === "transaction")).toBe(false);
    expect(m.links.map((l) => l.kind).sort()).toEqual([
      "income",
      "owns",
      "owns",
      "owns",
      "transfer",
    ]);
  });

  it("with transfers only, idle accounts are those with no transfers", () => {
    const m = buildModel(data, {
      ...DEFAULT_OPTIONS,
      showSpending: false,
      showIncome: false,
      hideIdleAccounts: true,
    });
    expect(ids(m)).toEqual([institutionNode("item-1"), accountNode(10), accountNode(11)].sort());
    expect(m.links.filter((l) => l.kind === "transfer")).toHaveLength(1);
  });
});

describe("transfers", () => {
  it("are never income, and an unmatched one (an opening balance) is not activity", () => {
    const withExtras: GraphData = {
      ...data,
      transactions: [
        ...data.transactions.map((t) =>
          // The bank calls the incoming side "transfer in", which reads as income.
          t.id === 6 ? { ...t, income: true, source: "ONLINE TRANSFER FROM CHK" } : t,
        ),
        tx({ id: 9, accountId: 20, amountMinor: -8000, isTransfer: true, categoryId: null }),
      ],
    };
    const m = buildModel(withExtras, {
      ...DEFAULT_OPTIONS,
      showSpending: false,
      hideIdleAccounts: true,
    });
    expect(m.nodes.some((n) => n.label === "ONLINE TRANSFER FROM CHK")).toBe(false);
    expect(m.nodes.some((n) => n.id === accountNode(20))).toBe(false);
    expect(m.nodes.some((n) => n.id === accountNode(11))).toBe(true);
  });
});

describe("transfers both ways", () => {
  it("are two links, one for each direction, each with its own total", () => {
    const both: GraphData = {
      ...data,
      transactions: [
        ...data.transactions,
        // Savings back to checking, twice.
        tx({
          id: 7,
          accountId: 11,
          amountMinor: 4_000,
          isTransfer: true,
          transferPairId: 8,
          categoryId: null,
        }),
        tx({
          id: 8,
          accountId: 10,
          amountMinor: -4_000,
          isTransfer: true,
          transferPairId: 7,
          categoryId: null,
        }),
        tx({
          id: 11,
          accountId: 11,
          amountMinor: 1_000,
          isTransfer: true,
          transferPairId: 12,
          categoryId: null,
        }),
        tx({
          id: 12,
          accountId: 10,
          amountMinor: -1_000,
          isTransfer: true,
          transferPairId: 11,
          categoryId: null,
        }),
      ],
    };
    const transfers = buildModel(both).links.filter((l) => l.kind === "transfer");
    expect(transfers).toHaveLength(2);
    expect(transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: accountNode(10),
          target: accountNode(11),
          weightMinor: 10_000,
        }),
        expect.objectContaining({
          source: accountNode(11),
          target: accountNode(10),
          weightMinor: 5_000,
        }),
      ]),
    );
  });
});

describe("graph simulation", () => {
  it("spreads nodes apart, keeps linked ones together, and settles", () => {
    const sim = new Simulation();
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, radius: 5 }));
    sim.setGraph(nodes, [{ source: "a", target: "b", distance: 40, strength: 1 }], 1);
    for (let i = 0; i < 2000 && sim.running; i++) sim.tick();
    expect(sim.running).toBe(false);
    const at = (id: string) => sim.nodes.get(id)!;
    const dist = (p: string, q: string) => Math.hypot(at(p).x - at(q).x, at(p).y - at(q).y);
    expect(dist("a", "b")).toBeLessThan(dist("c", "d") + 40);
    for (const [p, q] of [
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
    ])
      expect(dist(p!, q!)).toBeGreaterThan(10);
  });

  it("keeps the places of nodes it already had, and starts new ones by a neighbour", () => {
    const sim = new Simulation();
    sim.setGraph([{ id: "a", radius: 5 }], [], 1);
    sim.nodes.get("a")!.x = 500;
    sim.nodes.get("a")!.y = 500;
    sim.setGraph(
      [
        { id: "a", radius: 5 },
        { id: "b", radius: 3 },
      ],
      [{ source: "a", target: "b", distance: 30, strength: 1 }],
    );
    expect(sim.nodes.get("a")!.x).toBe(500);
    expect(Math.hypot(sim.nodes.get("b")!.x - 500, sim.nodes.get("b")!.y - 500)).toBeLessThan(25);
    expect(sim.nodeAt(500, 503)?.id).toBe("a");
  });
});

describe("opening a group", () => {
  it("adds its transactions calmly: nothing already there jumps, nothing new flies off", () => {
    const sim = new Simulation();
    const base = [
      { id: "bank", radius: 13, charge: 1 },
      { id: "acct", radius: 10, charge: 1 },
      { id: "other", radius: 10, charge: 1 },
      { id: "group", radius: 12, charge: 0.5 },
    ];
    const baseLinks = [
      { source: "bank", target: "acct", distance: 110, strength: 1 },
      { source: "bank", target: "other", distance: 110, strength: 1 },
      { source: "acct", target: "group", distance: 85, strength: 0.7 },
    ];
    sim.setGraph(base, baseLinks, 1);
    for (let i = 0; i < 3000 && sim.running; i++) sim.tick();
    const before = new Map([...sim.nodes.values()].map((n) => [n.id, { x: n.x, y: n.y }]));
    const group = before.get("group")!;

    // The group opens into 120 transactions at once.
    const txs = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, radius: 3, charge: 0.08 }));
    sim.setGraph(
      [...base, ...txs],
      [
        ...baseLinks,
        ...txs.map((t) => ({ source: "group", target: t.id, distance: 34, strength: 0.9 })),
      ],
      0.12,
    );
    // They start spread round the group, not on top of each other.
    const start = txs.map((t) => sim.nodes.get(t.id)!);
    const closest = Math.min(
      ...start.flatMap((a, i) => start.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))),
    );
    expect(closest).toBeGreaterThan(3);

    let fastest = 0;
    for (let i = 0; i < 400 && sim.running; i++) {
      const at = new Map([...sim.nodes.values()].map((n) => [n.id, { x: n.x, y: n.y }]));
      sim.tick();
      for (const n of sim.nodes.values()) {
        const p = at.get(n.id)!;
        fastest = Math.max(fastest, Math.hypot(n.x - p.x, n.y - p.y));
      }
    }
    expect(fastest).toBeLessThanOrEqual(10.01);
    // Nodes that were there move little.
    for (const id of ["bank", "acct", "other"]) {
      const p = before.get(id)!;
      const n = sim.nodes.get(id)!;
      expect(Math.hypot(n.x - p.x, n.y - p.y), id).toBeLessThan(60);
    }
    // The transactions stay round their group.
    for (const t of txs) {
      const n = sim.nodes.get(t.id)!;
      expect(Math.hypot(n.x - group.x, n.y - group.y)).toBeLessThan(300);
    }
  });
});

describe("category grouping and subcategories", () => {
  const food = { categoryId: 1, categoryName: "Food & Drink", categoryColor: "#f59e0b" };
  const spend: GraphData = {
    ...data,
    transactions: [
      tx({ id: 1, accountId: 10, ...food, subcategoryId: 2, subcategoryName: "Groceries" }),
      tx({ id: 2, accountId: 11, ...food, subcategoryId: 2, subcategoryName: "Groceries" }),
      tx({ id: 3, accountId: 11, ...food, amountMinor: 500 }),
    ],
  };

  it("gives each account its own category node, with subcategory nodes under it", () => {
    const m = buildModel(spend, DEFAULT_OPTIONS);
    const ids = m.nodes
      .filter((n) => n.kind === "cluster")
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(["cl:10:1", "cl:11:1", "sub:10:2", "sub:11:2"]);
    expect(m.links.some((l) => l.source === "cl:10:1" && l.target === "sub:10:2")).toBe(true);
    // The category counts everything in it, its subcategories included.
    expect(m.nodes.find((n) => n.id === "cl:11:1")!.weightMinor).toBe(1500);
  });

  it("can group a category into one node for all accounts", () => {
    const m = buildModel(spend, { ...DEFAULT_OPTIONS, groupCategories: true });
    const clusters = m.nodes.filter((n) => n.kind === "cluster");
    expect(clusters.map((n) => n.id).sort()).toEqual(["cl:all:1", "sub:all:2"]);
    expect(clusters.find((n) => n.id === "cl:all:1")!.weightMinor).toBe(2500);
    expect(clusters.find((n) => n.id === "sub:all:2")!.label).toBe("Groceries");
    // Both accounts link to the one Food & Drink node.
    const into = m.links
      .filter((l) => l.target === "cl:all:1")
      .map((l) => l.source)
      .sort();
    expect(into).toEqual([accountNode(10), accountNode(11)]);
  });

  it("shows a subcategory's transactions under it when opened", () => {
    const m = buildModel(spend, {
      ...DEFAULT_OPTIONS,
      groupCategories: true,
      groupMerchants: false,
      openClusters: new Set(["sub:all:2"]),
    });
    expect(
      m.links
        .filter((l) => l.source === "sub:all:2")
        .map((l) => l.target)
        .sort(),
    ).toEqual([txNode(1), txNode(2)]);
  });
});

describe("transfers to and from people", () => {
  const people: GraphData = {
    ...data,
    transactions: [
      tx({
        id: 1,
        merchant: "Zelle to Sam",
        person: "Sam Lee",
        amountMinor: 4000,
        categoryId: null,
      }),
      tx({
        id: 2,
        merchant: "Zelle from Sam",
        person: "sam lee",
        amountMinor: -1500,
        categoryId: null,
      }),
      tx({ id: 3, merchant: "Zelle to Ana", person: "Ana", amountMinor: 900, isTransfer: true }),
      // Income from a person stays income.
      tx({ id: 4, person: "Boss", amountMinor: -90000, income: true, source: "Boss" }),
    ],
  };

  it("gives each person a node, with arrows the way the money went", () => {
    const m = buildModel(people, DEFAULT_OPTIONS);
    const persons = m.nodes.filter((n) => n.kind === "person");
    expect(persons.map((n) => n.label).sort()).toEqual(["Ana", "Sam Lee"]);
    expect(persons.find((n) => n.label === "Sam Lee")!.transactionIds).toEqual([1, 2]);
    const ext = m.links.filter((l) => l.kind === "external");
    expect(ext).toContainEqual(
      expect.objectContaining({
        source: accountNode(10),
        target: "person:sam lee",
        weightMinor: 4000,
      }),
    );
    expect(ext).toContainEqual(
      expect.objectContaining({
        source: "person:sam lee",
        target: accountNode(10),
        weightMinor: 1500,
      }),
    );
    expect(m.nodes.some((n) => n.kind === "income" && n.label === "Boss")).toBe(true);
  });

  it("can be turned off, the payments going back to spending", () => {
    const m = buildModel(people, { ...DEFAULT_OPTIONS, showExternal: false });
    expect(m.nodes.some((n) => n.kind === "person")).toBe(false);
    expect(m.nodes.some((n) => n.kind === "cluster" && n.transactionIds.includes(1))).toBe(true);
  });
});

describe("merchant nodes", () => {
  const shop: GraphData = {
    ...data,
    transactions: [
      tx({ id: 1, merchant: "AMZN Mktp", merchantGroup: "Amazon" }),
      tx({ id: 2, merchant: "Amazon.com", merchantGroup: "Amazon", amountMinor: 500 }),
      tx({ id: 3, merchant: "Kroger" }),
      tx({ id: 4, merchant: "kroger " }),
    ],
  };
  const open = { ...DEFAULT_OPTIONS, openClusters: new Set([clusterNode(10, 5)]) };

  it("show one node per merchant (a group counting as one) in an open group", () => {
    const m = buildModel(shop, open);
    const kids = m.nodes.filter((n) => n.kind === "transaction");
    expect(kids.map((n) => n.label).sort()).toEqual(["Amazon", "Kroger"]);
    expect(kids.find((n) => n.label === "Amazon")!).toMatchObject({
      transactionIds: [1, 2],
      weightMinor: 1500,
    });
  });

  it("can show each transaction instead", () => {
    const m = buildModel(shop, { ...open, groupMerchants: false });
    expect(m.nodes.filter((n) => n.kind === "transaction")).toHaveLength(4);
  });

  it("carry institution logos", () => {
    const m = buildModel(
      {
        ...shop,
        institutions: [
          { id: "item-1", name: "Bank", color: null, logo: "data:image/png;base64,AA" },
        ],
      },
      DEFAULT_OPTIONS,
    );
    expect(m.nodes.find((n) => n.kind === "institution")!.logo).toBe("data:image/png;base64,AA");
  });
});
