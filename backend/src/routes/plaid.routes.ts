import { Router } from "express";
import { z } from "zod";
import { FAKE_INSTITUTIONS, FakePlaidGateway } from "../plaid/fake-gateway.js";
import type { GatewayProvider } from "../plaid/provider.js";
import type { AppDb } from "../db/client.js";
import {
  clearPlaidCredentials,
  credentialStatus,
  savePlaidCredentials,
} from "../services/credentials.service.js";
import type { TokenCipher } from "../services/crypto.js";
import type { PlaidService } from "../services/plaid.service.js";
import { getSettings } from "../services/settings.service.js";
import { notFound } from "../utils/errors.js";

const idParam = z.coerce.number().int().positive();
const environmentParam = z.enum(["sandbox", "production"]);

/** What the user is connecting: a bank (the default) or a brokerage / retirement plan. */
const linkTokenBody = z.object({ kind: z.enum(["banking", "investments"]).optional() }).strict();

const exchangeBody = z.object({
  publicToken: z.string().min(1).max(512),
  institution: z
    .object({
      id: z.string().max(100).optional(),
      name: z.string().max(200).optional(),
    })
    .optional(),
});

const credentialsBody = z.object({
  environment: environmentParam,
  clientId: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(1).max(200),
});

const reauthBody = z.object({ publicToken: z.string().max(512).optional() }).default({});

interface Deps {
  db: AppDb;
  cipher: TokenCipher;
  plaid: PlaidService;
  getGateway: GatewayProvider;
}

export function plaidRoutes({ db, cipher, plaid, getGateway }: Deps): Router {
  const router = Router();

  router.get("/plaid/status", (_req, res) => {
    const environment = getSettings(db).plaidEnvironment;
    res.json({
      environment,
      // Which Link experience the UI should show: the built-in demo picker or Plaid's real Link.
      linkMode: environment === "fake" ? "fake" : "plaid",
      credentialsSaved: credentialStatus(db),
    });
  });

  // Credentials are write-only: saved encrypted, never returned.
  router.put("/plaid/credentials", (req, res) => {
    const body = credentialsBody.parse(req.body);
    savePlaidCredentials(db, cipher, body.environment, {
      clientId: body.clientId,
      secret: body.secret,
    });
    res.json({ credentialsSaved: credentialStatus(db) });
  });

  router.delete("/plaid/credentials/:environment", (req, res) => {
    clearPlaidCredentials(db, environmentParam.parse(req.params["environment"]));
    res.json({ credentialsSaved: credentialStatus(db) });
  });

  router.post("/plaid/link-token", async (req, res) => {
    const body = linkTokenBody.parse(req.body ?? {});
    res.json(await plaid.createLinkToken(body.kind));
  });

  router.post("/plaid/exchange-token", async (req, res) => {
    const body = exchangeBody.parse(req.body);
    res.status(201).json(await plaid.exchange(body.publicToken, body.institution));
  });

  /** Each connected institution with its logo and brand color (for the calendar). */
  router.get("/institutions", (_req, res) => {
    res.json(plaid.institutions());
  });

  router.get("/plaid/items", (_req, res) => {
    res.json(plaid.list());
  });

  router.post("/plaid/items/:id/link-token", async (req, res) => {
    res.json(await plaid.createUpdateLinkToken(idParam.parse(req.params["id"])));
  });

  router.post("/plaid/items/:id/reauthenticated", async (req, res) => {
    const body = reauthBody.parse(req.body);
    res.json(await plaid.reauthenticated(idParam.parse(req.params["id"]), body.publicToken));
  });

  router.post("/plaid/items/:id/check", async (req, res) => {
    res.json(await plaid.check(idParam.parse(req.params["id"])));
  });

  router.delete("/plaid/items/:id", async (req, res) => {
    const force = req.query["force"] === "1";
    await plaid.remove(idParam.parse(req.params["id"]), force);
    res.status(204).end();
  });

  // Demo-mode helpers; they do not exist for Sandbox or Production.
  router.get("/plaid/fake/institutions", (_req, res) => {
    if (getSettings(db).plaidEnvironment !== "fake") throw notFound("Demo institutions");
    res.json(
      FAKE_INSTITUTIONS.map((i) => ({ id: i.id, name: i.name, accountCount: i.accounts.length })),
    );
  });

  router.post("/plaid/fake/items/:id/simulate-login-required", async (req, res) => {
    const gateway = getGateway();
    if (!(gateway instanceof FakePlaidGateway)) throw notFound("Demo tools");
    const id = idParam.parse(req.params["id"]);
    // The demo gateway keys its state by Plaid item ID, which the API summary does not expose.
    gateway.simulateLoginRequired(plaid.plaidItemIdOf(id));
    res.json(await plaid.check(id));
  });

  router.post("/plaid/fake/items/:id/simulate-credit-limit", (req, res) => {
    const gateway = getGateway();
    if (!(gateway instanceof FakePlaidGateway)) throw notFound("Demo tools");
    const body = z.object({ limit: z.number().positive().max(1_000_000) }).parse(req.body);
    gateway.simulateCreditLimit(plaid.plaidItemIdOf(idParam.parse(req.params["id"])), body.limit);
    res.status(204).end();
  });

  return router;
}
