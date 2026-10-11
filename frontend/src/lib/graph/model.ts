/**
 * Turns institutions, accounts, and transactions into the nodes and links the network graph draws.
 *
 * - An institution links to its accounts.
 * - An account links to its spending, grouped by category into clusters: one per account, or,
 *   with `groupCategories`, one per category shared by every account that spent in it. Spending
 *   in a subcategory hangs off its category's cluster in a cluster of its own (Food & Drink, then
 *   Groceries). A cluster can be opened to show its transactions one by one.
 * - Money in that counts as income comes from an income node (who paid it) outside the
 *   institutions, linked to the account it went into.
 * - Transfers between the user's own accounts link the two accounts (one line per pair of
 *   accounts, as thick as the money moved).
 * - With `showExternal`, payments to and from other people (Zelle and the like) link the account
 *   with a node for the person, pointing the way the money went.
 */

export interface GraphData {
  institutions: Array<{ id: string; name: string; color: string | null }>;
  accounts: Array<{
    id: number;
    institutionId: string;
    name: string;
    type: string;
    subtype: string | null;
    balanceMinor: number | null;
    color: string | null;
  }>;
  transactions: GraphTx[];
}

export interface GraphTx {
  id: number;
  accountId: number;
  date: string;
  merchant: string;
  amountMinor: number;
  pending: boolean;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  /** The subcategory, when the transaction has one. */
  subcategoryId?: number | null;
  subcategoryName?: string | null;
  subcategoryColor?: string | null;
  isTransfer: boolean;
  transferPairId: number | null;
  /** The person on the other side of a payment, when known. */
  person?: string | null;
  income: boolean;
  source: string | null;
}

export type NodeKind = "institution" | "account" | "income" | "person" | "cluster" | "transaction";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  color: string;
  /** Dollars this node stands for (spending of a cluster, income of a source, ...), in cents. */
  weightMinor: number;
  /** Transactions behind the node (one for a transaction node). */
  transactionIds: number[];
  /** For clusters and transactions: the account they belong to. */
  accountId?: number;
  /** For a cluster: whether it is open (its transactions are shown instead). */
  open?: boolean;
}

export type LinkKind = "owns" | "spends" | "income" | "transfer" | "external";

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  kind: LinkKind;
  /** Money along the link, in cents (0 for structure, such as an institution owning an account). */
  weightMinor: number;
}

export interface Model {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface ModelOptions {
  /** Clusters shown as their transactions. */
  openClusters: ReadonlySet<string>;
  /** Show income sources and their links. */
  showIncome: boolean;
  /** Show transfers between accounts. */
  showTransfers: boolean;
  /** Show payments to and from other people, each person as a node. */
  showExternal: boolean;
  /** Show spending: the category groups and their transactions. */
  showSpending: boolean;
  /** One node per category for all accounts, instead of one per account. */
  groupCategories: boolean;
  /** Leave out accounts with no transactions in the period. */
  hideIdleAccounts: boolean;
  /** Only transactions whose merchant, category, or source contains this (case does not matter). */
  search: string;
}

export const DEFAULT_OPTIONS: ModelOptions = {
  openClusters: new Set(),
  showIncome: true,
  showTransfers: true,
  showExternal: true,
  showSpending: true,
  groupCategories: false,
  hideIdleAccounts: false,
  search: "",
};

const INSTITUTION_COLOR = "#a78bfa";
const INCOME_COLOR = "#22c55e";
const TRANSFER_COLOR = "#38bdf8";
const PERSON_COLOR = "#f97316";
const UNCATEGORIZED_COLOR = "#94a3b8";

export const institutionNode = (id: string): string => `inst:${id}`;
export const accountNode = (id: number): string => `acct:${id}`;
/** A category cluster: an account's, or (account null) the one shared by all accounts. */
export const clusterNode = (accountId: number | null, categoryId: number | null): string =>
  `cl:${accountId ?? "all"}:${categoryId ?? "none"}`;
/** A subcategory cluster, under its category's cluster. */
export const subclusterNode = (accountId: number | null, subcategoryId: number): string =>
  `sub:${accountId ?? "all"}:${subcategoryId}`;
export const txNode = (id: number): string => `tx:${id}`;
const incomeNode = (source: string): string => `inc:${source.trim().toLowerCase()}`;
export const personNode = (name: string): string => `person:${name.trim().toLowerCase()}`;

/**
 * Which group a transaction belongs to in the graph. With `people`, a payment to or from another
 * person (not between the user's own accounts, and not income) is an external transfer.
 */
export function groupOf(
  t: GraphTx,
  people = false,
): "income" | "transfer" | "external" | "spending" {
  // Money moved between the user's own accounts is never income, whatever the bank calls it.
  if (t.isTransfer && t.transferPairId !== null) return "transfer";
  if (people && t.person && !t.income) return "external";
  if (t.isTransfer) return "transfer";
  if (t.income) return "income";
  return "spending";
}

function matches(t: GraphTx, search: string): boolean {
  if (search === "") return true;
  const q = search.toLowerCase();
  return [t.merchant, t.categoryName, t.subcategoryName, t.source, t.person].some((v) =>
    v?.toLowerCase().includes(q),
  );
}

export function buildModel(data: GraphData, options: ModelOptions = DEFAULT_OPTIONS): Model {
  const nodes = new Map<string, GraphNode>();
  const links = new Map<string, GraphLink>();
  const search = options.search.trim();
  const txs = data.transactions.filter((t) => matches(t, search));
  const byId = new Map(data.transactions.map((t) => [t.id, t]));
  // Accounts with activity of a kind that is shown.
  const shownKinds = {
    income: options.showIncome,
    transfer: options.showTransfers,
    external: options.showExternal,
    spending: options.showSpending,
  };
  const busy = new Set<number>();
  for (const t of txs) {
    const group = groupOf(t, options.showExternal);
    if (!shownKinds[group]) continue;
    if (group === "transfer") {
      // A transfer is drawn only when both sides were matched; then both accounts are active.
      const pair = t.transferPairId === null ? undefined : byId.get(t.transferPairId);
      if (!pair || pair.accountId === t.accountId) continue;
      busy.add(pair.accountId);
    }
    busy.add(t.accountId);
  }

  const addLink = (source: string, target: string, kind: LinkKind, weightMinor: number) => {
    const id = `${kind}:${source}>${target}`;
    const existing = links.get(id);
    if (existing) existing.weightMinor += weightMinor;
    else links.set(id, { id, source, target, kind, weightMinor });
  };

  // Accounts shown, and their institutions.
  // While searching, only accounts with a match are shown.
  const accounts = data.accounts.filter(
    (a) => busy.has(a.id) || (!options.hideIdleAccounts && search === ""),
  );
  const shownAccounts = new Set(accounts.map((a) => a.id));
  for (const inst of data.institutions) {
    if (!accounts.some((a) => a.institutionId === inst.id)) continue;
    nodes.set(institutionNode(inst.id), {
      id: institutionNode(inst.id),
      kind: "institution",
      label: inst.name,
      color: inst.color ?? INSTITUTION_COLOR,
      weightMinor: 0,
      transactionIds: [],
    });
  }
  for (const a of accounts) {
    nodes.set(accountNode(a.id), {
      id: accountNode(a.id),
      kind: "account",
      label: a.name,
      color: a.color ?? UNCATEGORIZED_COLOR,
      weightMinor: Math.abs(a.balanceMinor ?? 0),
      transactionIds: [],
      accountId: a.id,
    });
    if (nodes.has(institutionNode(a.institutionId))) {
      addLink(institutionNode(a.institutionId), accountNode(a.id), "owns", 0);
    }
  }

  const addTx = (t: GraphTx, color: string) => {
    nodes.set(txNode(t.id), {
      id: txNode(t.id),
      kind: "transaction",
      label: t.merchant,
      color,
      weightMinor: Math.abs(t.amountMinor),
      transactionIds: [t.id],
      accountId: t.accountId,
    });
  };

  for (const t of txs) {
    if (!shownAccounts.has(t.accountId)) continue;
    const account = accountNode(t.accountId);
    const amount = Math.abs(t.amountMinor);
    const group = groupOf(t, options.showExternal);

    if (group === "external") {
      const name = t.person!.trim();
      const person = personNode(name);
      const node = nodes.get(person) ?? {
        id: person,
        kind: "person" as const,
        label: name,
        color: PERSON_COLOR,
        weightMinor: 0,
        transactionIds: [],
      };
      node.weightMinor += amount;
      node.transactionIds.push(t.id);
      nodes.set(person, node);
      // The arrow points the way the money went.
      if (t.amountMinor > 0) addLink(account, person, "external", amount);
      else addLink(person, account, "external", amount);
      continue;
    }

    if (group === "income") {
      if (!options.showIncome) continue;
      const source = incomeNode(t.source ?? t.merchant);
      const node = nodes.get(source) ?? {
        id: source,
        kind: "income" as const,
        label: t.source ?? t.merchant,
        color: INCOME_COLOR,
        weightMinor: 0,
        transactionIds: [],
      };
      node.weightMinor += amount;
      node.transactionIds.push(t.id);
      nodes.set(source, node);
      addLink(source, account, "income", amount);
      continue;
    }

    if (group === "transfer") {
      if (!options.showTransfers) continue;
      const pair = t.transferPairId === null ? undefined : byId.get(t.transferPairId);
      // Each matched pair is drawn once, from the side the money left.
      if (!pair || !shownAccounts.has(pair.accountId) || pair.accountId === t.accountId) continue;
      if (t.amountMinor < 0) continue;
      addLink(account, accountNode(pair.accountId), "transfer", amount);
      continue;
    }

    // Spending (and money in that is not income, such as refunds) goes into a category cluster.
    if (!options.showSpending) continue;
    const owner = options.groupCategories ? null : t.accountId;
    const cluster = clusterNode(owner, t.categoryId);
    const color = t.categoryColor ?? UNCATEGORIZED_COLOR;
    const clusterOf = (id: string, label: string, c: string): GraphNode => {
      const node = nodes.get(id) ?? {
        id,
        kind: "cluster" as const,
        label,
        color: c,
        weightMinor: 0,
        transactionIds: [],
        ...(owner === null ? {} : { accountId: owner }),
        open: options.openClusters.has(id),
      };
      node.weightMinor += t.amountMinor; // refunds take away
      node.transactionIds.push(t.id);
      nodes.set(id, node);
      return node;
    };
    const node = clusterOf(cluster, t.categoryName ?? "Uncategorized", color);
    addLink(account, cluster, "spends", amount);
    // A subcategory gets its own cluster under the category's, holding its transactions.
    let holder = node;
    let txColor = color;
    if (t.subcategoryId != null) {
      const sub = subclusterNode(owner, t.subcategoryId);
      txColor = t.subcategoryColor ?? color;
      holder = clusterOf(sub, t.subcategoryName ?? "Subcategory", txColor);
      addLink(cluster, sub, "spends", amount);
    }
    if (holder.open) {
      addTx(t, txColor);
      addLink(holder.id, txNode(t.id), "spends", amount);
    }
  }

  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/** Each node's neighbours, for highlighting what a hovered node is connected to. */
export function neighbours(model: Model): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const n of model.nodes) map.set(n.id, new Set());
  for (const l of model.links) {
    map.get(l.source)?.add(l.target);
    map.get(l.target)?.add(l.source);
  }
  return map;
}

export const LINK_COLORS: Record<LinkKind, string> = {
  owns: "#64748b",
  spends: "#64748b",
  income: INCOME_COLOR,
  transfer: TRANSFER_COLOR,
  external: PERSON_COLOR,
};
