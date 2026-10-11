import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { isRealDate } from "../utils/dates.js";
import { listAccounts } from "./account.service.js";
import { IS_INCOME } from "./analytics.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Everything the network graph draws for a period: institutions, their accounts, and the accounts'
 * transactions, each marked with its (top-level) category, its transfer partner, and whether it is
 * income. The page lays these out and groups them; this only gathers them.
 */

export interface GraphInstitution {
  id: string;
  name: string;
  color: string | null;
  logo: string | null;
}

export interface GraphAccount {
  id: number;
  institutionId: string;
  name: string;
  type: string;
  subtype: string | null;
  balanceMinor: number | null;
  color: string | null;
}

export interface GraphTransaction {
  id: number;
  accountId: number;
  date: string;
  merchant: string;
  /** Plaid's sign: positive is money out. */
  amountMinor: number;
  pending: boolean;
  /** The top-level category (a subcategory is grouped under its parent). */
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  /** The subcategory, when the transaction has one (null when it is filed under a top category). */
  subcategoryId: number | null;
  subcategoryName: string | null;
  subcategoryColor: string | null;
  isTransfer: boolean;
  /** The other side of a transfer between the user's own accounts, when it was matched. */
  transferPairId: number | null;
  /**
   * The person on the other side of a payment (Zelle and the like): who it was sent to, for money
   * out, or who sent it, for money in. Names typed in by the user win.
   */
  person: string | null;
  /** Money in that counts as income; `source` is who paid it. */
  income: boolean;
  source: string | null;
}

export interface Graph {
  from: string;
  to: string;
  institutions: GraphInstitution[];
  accounts: GraphAccount[];
  transactions: GraphTransaction[];
  /** More transactions matched than are returned (the newest are kept). */
  truncated: boolean;
}

export const MAX_GRAPH_TRANSACTIONS = 5000;
const MANUAL_INSTITUTION = "manual";

interface Row {
  id: number;
  account_id: number;
  date: string;
  merchant: string;
  amount_minor: number;
  pending: number;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  sub_id: number | null;
  sub_name: string | null;
  sub_color: string | null;
  person: string | null;
  is_transfer: number;
  transfer_pair_id: number | null;
  income: number;
  source: string | null;
}

export function transactionGraph(db: AppDb, from: string, to: string): Graph {
  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    throw new AppError(400, "invalid_range", "Choose a start date on or before the end date.");
  }
  const settings = getSettings(db);
  const accounts = listAccounts(db).filter(
    (a) => a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment,
  );
  const ids = new Set(accounts.map((a) => a.id));

  const items = db.all<{ id: number; name: string; color: string | null; logo: string | null }>(sql`
    select id, institution_name as name, institution_color as color, institution_logo as logo
    from plaid_items where environment = ${settings.plaidEnvironment}`);
  const institutions: GraphInstitution[] = items
    .filter((i) => accounts.some((a) => a.itemId === i.id))
    .map((i) => ({ id: `item-${i.id}`, name: i.name, color: i.color, logo: i.logo }));
  if (accounts.some((a) => a.itemId === null)) {
    institutions.push({ id: MANUAL_INSTITUTION, name: "Kept by hand", color: null, logo: null });
  }

  const rows =
    ids.size === 0
      ? []
      : db.all<Row>(sql`
    select t.id, t.account_id, coalesce(t.authorized_date, t.date) as date,
      coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
      t.amount_minor, t.pending,
      coalesce(pc.id, c.id) as category_id,
      coalesce(pc.name, c.name) as category_name,
      coalesce(pc.color, c.color) as category_color,
      (case when pc.id is not null then c.id end) as sub_id,
      (case when pc.id is not null then c.name end) as sub_name,
      (case when pc.id is not null then c.color end) as sub_color,
      t.is_transfer, t.transfer_pair_id,
      (case when t.amount_minor < 0 and t.is_transfer = 0 and ${IS_INCOME} then 1 else 0 end) as income,
      coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), '')) as source,
      (case when t.amount_minor > 0
        then coalesce(nullif(trim(t.recipient_user), ''), nullif(trim(t.recipient), ''))
        else coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), '')) end) as person
    from transactions t
      join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
      left join categories pc on pc.id = c.parent_id
    where coalesce(t.authorized_date, t.date) between ${from} and ${to}
      and t.account_id in (${sql.join(
        [...ids].map((id) => sql`${id}`),
        sql`, `,
      )})
    order by date desc, t.id desc
    limit ${MAX_GRAPH_TRANSACTIONS + 1}`);

  const truncated = rows.length > MAX_GRAPH_TRANSACTIONS;
  return {
    from,
    to,
    institutions,
    accounts: accounts.map((a) => ({
      id: a.id,
      institutionId: a.itemId === null ? MANUAL_INSTITUTION : `item-${a.itemId}`,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      balanceMinor: a.currentBalanceMinor,
      color: a.color,
    })),
    transactions: rows.slice(0, MAX_GRAPH_TRANSACTIONS).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      date: r.date,
      merchant: r.merchant,
      amountMinor: r.amount_minor,
      pending: r.pending === 1,
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryColor: r.category_color,
      subcategoryId: r.sub_id,
      subcategoryName: r.sub_name,
      subcategoryColor: r.sub_color,
      isTransfer: r.is_transfer === 1,
      transferPairId: r.transfer_pair_id,
      person: r.person,
      income: r.income === 1,
      source: r.income === 1 ? (r.source ?? r.merchant) : null,
    })),
    truncated,
  };
}
