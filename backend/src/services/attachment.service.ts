import { asc, eq, inArray, sql } from "drizzle-orm";
import { attachments, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";

/**
 * Files attached to transactions: receipts, warranties, invoices. They are kept inside the database,
 * so they are encrypted and backed up with everything else.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
  "text/plain",
] as const;

export interface AttachmentDto {
  id: number;
  transactionId: number;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

const columns = {
  id: attachments.id,
  transactionId: attachments.transactionId,
  name: attachments.name,
  mime: attachments.mime,
  size: attachments.size,
  createdAt: attachments.createdAt,
};

export function listAttachments(db: AppDb, transactionId: number): AttachmentDto[] {
  return db
    .select(columns)
    .from(attachments)
    .where(eq(attachments.transactionId, transactionId))
    .orderBy(asc(attachments.id))
    .all();
}

/** How many files each of these transactions has (those with none are left out). */
export function attachmentCounts(db: AppDb, ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: attachments.transactionId, n: sql<number>`count(*)` })
    .from(attachments)
    .where(inArray(attachments.transactionId, ids))
    .groupBy(attachments.transactionId)
    .all();
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function addAttachment(
  db: AppDb,
  transactionId: number,
  file: { name: string; mime: string; data: Buffer },
  now: string = new Date().toISOString(),
): AttachmentDto {
  const exists = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!exists) throw notFound("That transaction");
  if (file.data.length === 0) throw new AppError(400, "empty_file", "That file is empty.");
  if (file.data.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError(413, "file_too_large", "Attach files of up to 10 MB.");
  }
  const mime = file.mime.toLowerCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(mime)) {
    throw new AppError(
      415,
      "unsupported_file",
      "Attach a picture (JPEG, PNG, GIF, WebP, HEIC), a PDF, or a text file.",
    );
  }
  const name =
    file.name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 200) || "attachment";
  return db
    .insert(attachments)
    .values({ transactionId, name, mime, size: file.data.length, data: file.data, createdAt: now })
    .returning(columns)
    .get();
}

export function getAttachmentFile(
  db: AppDb,
  id: number,
): { name: string; mime: string; data: Buffer } {
  const row = db
    .select({ name: attachments.name, mime: attachments.mime, data: attachments.data })
    .from(attachments)
    .where(eq(attachments.id, id))
    .get();
  if (!row) throw notFound("That attachment");
  return row;
}

export function deleteAttachment(db: AppDb, id: number): void {
  const result = db.delete(attachments).where(eq(attachments.id, id)).run();
  if (result.changes === 0) throw notFound("That attachment");
}
