import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { REPEAT_CHOICES, repeatFromTransaction } from "../services/calendar.service.js";
import { getSettings } from "../services/settings.service.js";
import {
  createManualTransaction,
  deleteManualTransaction,
  updateAnyTransaction,
  updateManyTransactions,
} from "../services/manual-transaction.service.js";
import { transactionCashback } from "../services/cashback.service.js";
import { transactionGraph } from "../services/graph.service.js";
import {
  linkTransferToAccount,
  pairTransfers,
  transferCandidates,
  unlinkTransfer,
} from "../services/transfer-link.service.js";
import { linkMirror, mirrorCandidates, unlinkMirror } from "../services/paypal-mirror.service.js";
import { refundAllocation } from "../services/refund-allocation.service.js";
import { refundCandidates, refundsOf, setRefundOf } from "../services/refund.service.js";
import { MAX_SPLITS, setSplits } from "../services/split.service.js";
import { getTransaction, listTransactions, SORTS } from "../services/transaction.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  focus: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
  from: date.optional(),
  to: date.optional(),
  pending: z.enum(["true", "false"]).optional(),
  online: z.enum(["true", "false"]).optional(),
  institution: z.string().min(1).max(200).optional(),
  dateBasis: z.enum(["transaction", "posted"]).optional(),
  q: z.string().max(200).optional(),
  // One category, or several separated by commas ("3,7,none"): a transaction in any of them.
  category: z
    .string()
    .max(2000)
    .optional()
    .transform((v, ctx): Array<number | "none"> | undefined => {
      const parts = (v ?? "").split(",").filter(Boolean);
      if (parts.length === 0) return undefined;
      const out: Array<number | "none"> = [];
      for (const p of parts) {
        const n = Number(p);
        if (p === "none") out.push("none");
        else if (Number.isInteger(n) && n > 0) out.push(n);
        else {
          ctx.addIssue({ code: "custom", message: `Not a category: ${p}` });
          return z.NEVER;
        }
      }
      return out;
    }),
  direction: z.enum(["in", "out"]).optional(),
  transfer: z.literal("unmatched").optional(),
  sort: z.enum(SORTS).optional(),
});

/** The fields a user may change. Everything else comes from the bank and cannot be edited. */
const patchBody = z
  .object({
    categoryId: z.number().int().positive().nullable().optional(),
    merchant: z.string().max(200).nullable().optional(),
    recipient: z.string().max(100).nullable().optional(),
    sender: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    // True or false is the user's call on whether it was bought online; null goes back to the bank's.
    online: z.boolean().nullable().optional(),
    // True or false is the user's decision; null lets the app decide by matching it again.
    isTransfer: z.boolean().nullable().optional(),
    // Only for transactions entered by hand (a bank's own cannot change these):
    accountId: z.number().int().positive().optional(),
    date: date.optional(),
    description: z.string().max(200).nullable().optional(),
    amountMinor: z.number().int().min(1).max(100_000_000_000).optional(),
    direction: z.enum(["out", "in"]).optional(),
    pending: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });

/** One change for many transactions at once: a category, or whether they are transfers. */
const bulkBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    categoryId: z.number().int().positive().nullable().optional(),
    isTransfer: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((body) => body.categoryId !== undefined || body.isTransfer !== undefined, {
    message: "Nothing to change.",
  });

const createBody = z
  .object({
    accountId: z.number().int().positive(),
    date,
    merchant: z.string().min(1).max(200),
    description: z.string().max(200).nullable().optional(),
    amountMinor: z.number().int().min(1).max(100_000_000_000),
    direction: z.enum(["out", "in"]),
    categoryId: z.number().int().positive().nullable().optional(),
    recipient: z.string().max(100).nullable().optional(),
    sender: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    pending: z.boolean().optional(),
    isTransfer: z.boolean().optional(),
    /** Also expect it again: every week, every two weeks, or every month. */
    repeat: z.enum(REPEAT_CHOICES).optional(),
  })
  .strict();

export function transactionsRoutes(db: AppDb): Router {
  const router = Router();

  /** Adds each purchase's estimated card cashback (null when none applies). */
  const withCashback = <P extends { items: Array<{ id: number }> }>(page: P) => {
    const earned = transactionCashback(
      db,
      page.items.map((t) => t.id),
    );
    return {
      ...page,
      items: page.items.map((t) => ({ ...t, cashback: earned.get(t.id) ?? null })),
    };
  };

  /** Institutions, accounts, and transactions for the network graph. */
  router.get("/graph/transactions", (req, res) => {
    const q = z
      .object({ from: z.string().min(10).max(10), to: z.string().min(10).max(10) })
      .parse(req.query);
    res.json(transactionGraph(db, q.from, q.to));
  });

  router.get("/transactions", (req, res) => {
    const parsed = listQuery.parse(req.query);
    res.json(
      withCashback(
        listTransactions(db, {
          ...parsed,
          pending: parsed.pending === undefined ? undefined : parsed.pending === "true",
          online: parsed.online === undefined ? undefined : parsed.online === "true",
          environment: getSettings(db).plaidEnvironment,
        }),
      ),
    );
  });

  /** Splits a transaction across categories (an empty list un-splits it). */
  router.put("/transactions/:id/splits", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    const body = z
      .object({
        parts: z
          .array(
            z
              .object({
                categoryId: z.number().int().positive().nullable(),
                amountMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
                note: z.string().max(200).nullable().optional(),
              })
              .strict(),
          )
          .max(MAX_SPLITS),
      })
      .strict()
      .parse(req.body);
    res.json(setSplits(db, id, body.parts));
  });

  router.get("/transactions/:id", (req, res) => {
    const t = getTransaction(db, idParam.parse(req.params["id"]));
    res.json({ ...t, cashback: transactionCashback(db, [t.id]).get(t.id) ?? null });
  });

  router.post("/transactions/bulk", (req, res) => {
    const { ids, ...patch } = bulkBody.parse(req.body);
    res.json({ updated: updateManyTransactions(db, ids, patch) });
  });

  router.patch("/transactions/:id", (req, res) => {
    const body = patchBody.parse(req.body);
    const updated = updateAnyTransaction(db, idParam.parse(req.params["id"]), body);
    res.json({
      ...updated,
      cashback: transactionCashback(db, [updated.id]).get(updated.id) ?? null,
    });
  });

  /**
   * Links a transfer with an account the user keeps by hand, adding the other side there (for a
   * transfer that matched nothing, such as cash taken out into a wallet).
   */
  router.post("/transactions/:id/transfer-account", (req, res) => {
    const body = z.object({ accountId: z.number().int().positive() }).strict().parse(req.body);
    res.json(linkTransferToAccount(db, idParam.parse(req.params["id"]), body.accountId));
  });
  /** Undoes that link, removing the transaction it added. */
  router.delete("/transactions/:id/transfer-account", (req, res) => {
    res.json(unlinkTransfer(db, idParam.parse(req.params["id"])));
  });
  /** Transactions on other accounts that could be the other side of this transfer. */
  router.get("/transactions/:id/transfer-candidates", (req, res) => {
    res.json(transferCandidates(db, idParam.parse(req.params["id"])));
  });
  /** Pairs this transaction with another as the two sides of one transfer, replacing any pair. */
  router.post("/transactions/:id/transfer-pair", (req, res) => {
    const body = z.object({ otherId: idParam }).strict().parse(req.body);
    res.json(pairTransfers(db, idParam.parse(req.params["id"]), body.otherId));
  });
  /** Undoes this transaction's pair, whoever made it; it stays a transfer, one-sided. */
  router.delete("/transactions/:id/transfer-pair", (req, res) => {
    res.json(unlinkTransfer(db, idParam.parse(req.params["id"])));
  });
  /** Transactions on other accounts that could be the same purchase (PayPal and its card). */
  router.get("/transactions/:id/mirror-candidates", (req, res) => {
    res.json(mirrorCandidates(db, idParam.parse(req.params["id"])));
  });
  /** Links this and another transaction as one purchase; one counts, the other is a copy. */
  router.post("/transactions/:id/mirror", (req, res) => {
    const body = z.object({ otherId: idParam }).strict().parse(req.body);
    res.json(linkMirror(db, idParam.parse(req.params["id"]), body.otherId));
  });
  /** Undoes that link: both count again, and neither is linked automatically again. */
  router.delete("/transactions/:id/mirror", (req, res) => {
    res.json(unlinkMirror(db, idParam.parse(req.params["id"])));
  });
  /**
   * Charges this refund could give back, or for a charge the money back that could be its refund:
   * the likeliest first, optionally searched (`q`) or past the usual 6 months (`all`).
   */
  router.get("/transactions/:id/refund-candidates", (req, res) => {
    const query = z
      .object({
        q: z.string().max(100).optional(),
        all: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(req.query);
    res.json(
      refundCandidates(db, idParam.parse(req.params["id"]), {
        q: query.q,
        all: query.all === "true",
        limit: query.limit,
      }),
    );
  });
  /** The refunds linked to this charge. */
  router.get("/transactions/:id/refunds", (req, res) => {
    res.json(refundsOf(db, idParam.parse(req.params["id"])));
  });
  /**
   * How this refund of a split purchase is divided across the purchase's categories, with what is
   * left in each (null when it is not linked to a split purchase).
   */
  router.get("/transactions/:id/refund-allocation", (req, res) => {
    res.json(refundAllocation(db, idParam.parse(req.params["id"])));
  });
  /** Links this refund with the charge it gives back (null unlinks it). */
  router.put("/transactions/:id/refund-of", (req, res) => {
    const body = z.object({ originalId: idParam.nullable() }).strict().parse(req.body);
    res.json(setRefundOf(db, idParam.parse(req.params["id"]), body.originalId));
  });

  /** Adds a transaction by hand, to an account the user keeps by hand (cash, for example). */
  router.post("/transactions", (req, res) => {
    const { repeat, ...body } = createBody.parse(req.body);
    const now = new Date().toISOString();
    const result = db.transaction((tx) => {
      const created = createManualTransaction(tx as unknown as AppDb, body, now);
      const recurring = repeat
        ? repeatFromTransaction(tx as unknown as AppDb, created, repeat, now)
        : null;
      return { ...created, recurring };
    });
    res.status(201).json(result);
  });

  /** Deletes a transaction the user entered. Bank transactions cannot be deleted. */
  router.delete("/transactions/:id", (req, res) => {
    deleteManualTransaction(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  return router;
}
