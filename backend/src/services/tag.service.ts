import { asc, eq, inArray, sql } from "drizzle-orm";
import { tags, transactions, transactionTags } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";

/**
 * Tags: the user's own labels for transactions, across categories ("vacation 2026", "work trip"),
 * so a trip or a project can be added up whatever it was spent on.
 */

export interface TagDto {
  id: number;
  name: string;
  color: string | null;
  transactionCount: number;
}

export function listTags(db: AppDb): TagDto[] {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      transactionCount: sql<number>`(select count(*) from transaction_tags tt where tt.tag_id = ${tags.id})`,
    })
    .from(tags)
    .orderBy(asc(sql`lower(${tags.name})`))
    .all();
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new AppError(400, "invalid_name", "Give the tag a name.");
  return name;
}

/** The tag with this name (any case), if there is one. */
export function tagByName(db: AppDb, name: string): { id: number; name: string } | undefined {
  return db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${name.trim()})`)
    .get();
}

/** Makes a tag, or returns the one that already has this name. */
export function createTag(
  db: AppDb,
  input: { name: string; color?: string | null | undefined },
): TagDto {
  const name = cleanName(input.name);
  const existing = tagByName(db, name);
  const id =
    existing?.id ??
    db
      .insert(tags)
      .values({ name, color: input.color ?? null, createdAt: new Date().toISOString() })
      .returning({ id: tags.id })
      .get().id;
  return listTags(db).find((t) => t.id === id)!;
}

export function updateTag(
  db: AppDb,
  id: number,
  input: { name: string; color?: string | null | undefined },
): TagDto {
  const name = cleanName(input.name);
  const clash = tagByName(db, name);
  if (clash && clash.id !== id) {
    throw new AppError(409, "duplicate_tag", `There is already a tag named ${clash.name}.`);
  }
  const res = db
    .update(tags)
    .set({ name, ...(input.color !== undefined ? { color: input.color } : {}) })
    .where(eq(tags.id, id))
    .run();
  if (res.changes === 0) throw notFound("That tag");
  return listTags(db).find((t) => t.id === id)!;
}

/** Deletes the tag; the transactions keep everything else. */
export function deleteTag(db: AppDb, id: number): void {
  const res = db.delete(tags).where(eq(tags.id, id)).run();
  if (res.changes === 0) throw notFound("That tag");
}

export function transactionTagList(
  db: AppDb,
  transactionId: number,
): Array<{ id: number; name: string; color: string | null }> {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(eq(transactionTags.transactionId, transactionId))
    .orderBy(asc(sql`lower(${tags.name})`))
    .all();
}

/** Replaces a transaction's tags with these. */
export function setTransactionTags(
  db: AppDb,
  transactionId: number,
  tagIds: number[],
): Array<{ id: number; name: string; color: string | null }> {
  const tx = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!tx) throw notFound("That transaction");
  const wanted = [...new Set(tagIds)];
  if (wanted.length > 0) {
    const found = db.select({ id: tags.id }).from(tags).where(inArray(tags.id, wanted)).all();
    if (found.length !== wanted.length) {
      throw new AppError(400, "unknown_tag", "One of those tags does not exist.");
    }
  }
  db.transaction((t) => {
    t.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId)).run();
    for (const tagId of wanted) t.insert(transactionTags).values({ transactionId, tagId }).run();
  });
  return transactionTagList(db, transactionId);
}
