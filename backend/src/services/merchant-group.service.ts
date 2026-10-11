import { asc, eq, inArray } from "drizzle-orm";
import { merchantGroupMembers, merchantGroups } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { merchantKey } from "../utils/merchant.js";

/**
 * Merchant groups: several merchants the user counts as one ("AMZN Mktp", "Amazon.com" and
 * "Amazon Prime" as Amazon). Members are kept by their normalized name, so every spelling of a
 * member belongs too. A merchant is in one group at most; adding it to another moves it.
 */

export interface MerchantGroupDto {
  id: number;
  name: string;
  merchants: Array<{ key: string; name: string }>;
}

export interface MerchantGroupInput {
  name: string;
  merchants: string[];
}

export function listMerchantGroups(db: AppDb): MerchantGroupDto[] {
  const groups = db.select().from(merchantGroups).orderBy(asc(merchantGroups.name)).all();
  const members = db.select().from(merchantGroupMembers).all();
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    merchants: members
      .filter((m) => m.groupId === g.id)
      .map((m) => ({ key: m.merchantKey, name: m.merchantName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Each grouped merchant's key → its group. */
export function merchantGroupsByKey(
  db: Pick<AppDb, "select">,
): Map<string, { id: number; name: string }> {
  const rows = db
    .select({
      key: merchantGroupMembers.merchantKey,
      id: merchantGroups.id,
      name: merchantGroups.name,
    })
    .from(merchantGroupMembers)
    .innerJoin(merchantGroups, eq(merchantGroups.id, merchantGroupMembers.groupId))
    .all();
  return new Map(rows.map((r) => [r.key, { id: r.id, name: r.name }]));
}

/**
 * Puts one merchant in a group (an existing one, or a new one by name), or takes it out of its
 * group (`groupId` null and no new name). A group left empty is removed.
 */
export function setMerchantGroup(
  db: AppDb,
  input: { merchant: string; groupId?: number | null | undefined; newGroup?: string | undefined },
): MerchantGroupDto[] {
  const key = merchantKey(input.merchant);
  if (!key) throw new AppError(400, "invalid_merchant", "That merchant has no usable name.");
  const newName = input.newGroup?.trim();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    let target: number | null = input.groupId ?? null;
    if (newName) {
      target = tx
        .insert(merchantGroups)
        .values({ name: newName, createdAt: now, updatedAt: now })
        .returning({ id: merchantGroups.id })
        .get().id;
    } else if (target !== null) {
      const exists = tx
        .select({ id: merchantGroups.id })
        .from(merchantGroups)
        .where(eq(merchantGroups.id, target))
        .get();
      if (!exists) throw notFound("That group");
    }
    tx.delete(merchantGroupMembers).where(eq(merchantGroupMembers.merchantKey, key)).run();
    if (target !== null) {
      tx.insert(merchantGroupMembers)
        .values({ groupId: target, merchantKey: key, merchantName: input.merchant.trim() })
        .run();
    }
    removeEmptyGroups(tx);
  });
  return listMerchantGroups(db);
}

/** Renames a group. */
export function renameMerchantGroup(db: AppDb, id: number, name: string): MerchantGroupDto[] {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, "invalid_name", "Give the group a name.");
  const res = db
    .update(merchantGroups)
    .set({ name: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(merchantGroups.id, id))
    .run();
  if (res.changes === 0) throw notFound("That group");
  return listMerchantGroups(db);
}

function removeEmptyGroups(tx: Pick<AppDb, "select" | "delete">): void {
  for (const g of tx.select({ id: merchantGroups.id }).from(merchantGroups).all()) {
    const has = tx
      .select({ id: merchantGroupMembers.id })
      .from(merchantGroupMembers)
      .where(eq(merchantGroupMembers.groupId, g.id))
      .get();
    if (!has) tx.delete(merchantGroups).where(eq(merchantGroups.id, g.id)).run();
  }
}

/** Each grouped merchant's key → its group's name. */
export function merchantGroupNames(db: Pick<AppDb, "select">): Map<string, string> {
  const rows = db
    .select({ key: merchantGroupMembers.merchantKey, name: merchantGroups.name })
    .from(merchantGroupMembers)
    .innerJoin(merchantGroups, eq(merchantGroups.id, merchantGroupMembers.groupId))
    .all();
  return new Map(rows.map((r) => [r.key, r.name]));
}

function members(input: MerchantGroupInput) {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "invalid_name", "Give the group a name.");
  const byKey = new Map<string, string>();
  for (const m of input.merchants) {
    const key = merchantKey(m);
    if (key && !byKey.has(key)) byKey.set(key, m.trim());
  }
  if (byKey.size < 1) throw new AppError(400, "no_merchants", "Choose the merchants to group.");
  return { name, byKey };
}

function save(db: AppDb, groupId: number | null, input: MerchantGroupInput): MerchantGroupDto {
  const { name, byKey } = members(input);
  const now = new Date().toISOString();
  let id = groupId ?? 0;
  db.transaction((tx) => {
    if (groupId === null) {
      id = tx
        .insert(merchantGroups)
        .values({ name, createdAt: now, updatedAt: now })
        .returning({ id: merchantGroups.id })
        .get().id;
    } else {
      const res = tx
        .update(merchantGroups)
        .set({ name, updatedAt: now })
        .where(eq(merchantGroups.id, groupId))
        .run();
      if (res.changes === 0) throw notFound("That group");
      tx.delete(merchantGroupMembers).where(eq(merchantGroupMembers.groupId, groupId)).run();
    }
    // A merchant moves here from any other group.
    tx.delete(merchantGroupMembers)
      .where(inArray(merchantGroupMembers.merchantKey, [...byKey.keys()]))
      .run();
    for (const [key, merchantName] of byKey) {
      tx.insert(merchantGroupMembers).values({ groupId: id, merchantKey: key, merchantName }).run();
    }
    // A group left with no merchants is removed.
    removeEmptyGroups(tx);
  });
  return listMerchantGroups(db).find((g) => g.id === id)!;
}

export const createMerchantGroup = (db: AppDb, input: MerchantGroupInput) => save(db, null, input);
export const updateMerchantGroup = (db: AppDb, id: number, input: MerchantGroupInput) =>
  save(db, id, input);

export function deleteMerchantGroup(db: AppDb, id: number): void {
  const res = db.delete(merchantGroups).where(eq(merchantGroups.id, id)).run();
  if (res.changes === 0) throw notFound("That group");
}
