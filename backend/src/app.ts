import fs from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ZodError } from "zod";
import type { AppDb } from "./db/client.js";
import { cors, hostCheck, requireToken, tokenBootstrap } from "./middleware/security.js";
import { createGatewayProvider, type GatewayProvider } from "./plaid/provider.js";
import { accountsRoutes } from "./routes/accounts.routes.js";
import { analyticsRoutes } from "./routes/analytics.routes.js";
import { categoriesRoutes } from "./routes/categories.routes.js";
import { dashboardRoutes } from "./routes/dashboard.routes.js";
import { dataRoutes } from "./routes/data.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { insightsRoutes } from "./routes/insights.routes.js";
import { investmentsRoutes } from "./routes/investments.routes.js";
import { merchantsRoutes } from "./routes/merchants.routes.js";
import { calendarRoutes } from "./routes/calendar.routes.js";
import { sandboxRoutes } from "./routes/sandbox.routes.js";
import { planningRoutes } from "./routes/planning.routes.js";
import { trackedSubscriptionsRoutes } from "./routes/tracked-subscriptions.routes.js";
import { cashbackRoutes } from "./routes/cashback.routes.js";
import { tspRoutes } from "./routes/tsp.routes.js";
import { taxesRoutes } from "./routes/taxes.routes.js";
import { plaidRoutes } from "./routes/plaid.routes.js";
import { settingsRoutes } from "./routes/settings.routes.js";
import { syncRoutes } from "./routes/sync.routes.js";
import { transactionsRoutes } from "./routes/transactions.routes.js";
import type { ClientOptions as CardPriceClientOptions } from "./services/card-price.service.js";
import { collectionPricesRoutes } from "./routes/collection-prices.routes.js";
import { aiRoutes } from "./routes/ai.routes.js";
import type { TokenCipher } from "./services/crypto.js";
import { createPlaidService } from "./services/plaid.service.js";
import { createSyncService, type SyncService } from "./services/sync.service.js";
import { AppError } from "./utils/errors.js";

export interface AppOptions {
  db: AppDb;
  port: number;
  token: string;
  version: string;
  /** Encrypts Plaid access tokens and saved credentials. */
  cipher: TokenCipher;
  /** The master key, offered to the user as their recovery key. Omit to leave that off. */
  recoveryKey?: string | undefined;
  /** Chooses the Plaid gateway (demo, Sandbox, Production). Defaults to the settings-driven one. */
  getGateway?: GatewayProvider | undefined;
  /** The sync service. The server passes its own so it can also start launch and timed syncs. */
  sync?: SyncService | undefined;
  /** The app's data folder: where backups and exports are written. Omit to leave those features off. */
  dataDir?: string | undefined;
  /** Folder with the database migrations, used to tell whether a backup is from a newer version. */
  migrationsDir?: string | undefined;
  /** Built frontend folder, served so the UI can also be opened in a browser tab. */
  staticDir?: string | undefined;
  /** How the card price client reaches JustTCG (tests pass a fake fetch and no pacing). */
  cardPriceClient?: CardPriceClientOptions | undefined;
  /** Development only: also accept requests from the Vite dev server's origin. */
  allowDevOrigin?: boolean | undefined;
}

export function createApp({
  db,
  port,
  token,
  version,
  cipher,
  recoveryKey,
  getGateway = createGatewayProvider(db, cipher),
  sync = createSyncService({ db, cipher, getGateway }),
  staticDir,
  allowDevOrigin,
  dataDir,
  migrationsDir,
  cardPriceClient,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Order matters: reject foreign hosts/origins first, answer preflights, then check the token.
  app.use(hostCheck(port));
  app.use(cors(allowDevOrigin));
  app.use(tokenBootstrap(token));

  const plaid = createPlaidService({ db, cipher, getGateway });

  app.use("/api", requireToken(token));
  // File imports (TSP price history since 2003 can be a few megabytes) get a larger limit.
  const importJson = express.json({ limit: "8mb" });
  const json = express.json({ limit: "1mb" });
  app.use("/api", (req, res, next) =>
    /^\/(collections\/import|tsp\/import|tsp\/prices\/import|accounts\/\d+\/tsp\/activity\/import|accounts\/manual\/\d+\/import-csv)$/.test(
      req.path,
    )
      ? importJson(req, res, next)
      : json(req, res, next),
  );
  app.use("/api", healthRoutes(db, version));
  app.use("/api", settingsRoutes(db));
  app.use("/api", plaidRoutes({ db, cipher, plaid, getGateway }));
  app.use("/api", accountsRoutes(db, cardPriceClient?.fetchImpl));
  app.use("/api", collectionPricesRoutes(db, cipher, cardPriceClient));
  app.use("/api", syncRoutes(sync));
  app.use("/api", categoriesRoutes(db));
  app.use("/api", analyticsRoutes(db));
  app.use("/api", dashboardRoutes(db));
  app.use("/api", investmentsRoutes(db));
  app.use("/api", insightsRoutes(db));
  app.use("/api", merchantsRoutes(db));
  app.use("/api", calendarRoutes(db));
  app.use("/api", cashbackRoutes(db));
  app.use("/api", planningRoutes(db));
  app.use("/api", trackedSubscriptionsRoutes(db));
  app.use("/api", sandboxRoutes(db));
  app.use("/api", tspRoutes(db));
  app.use("/api", taxesRoutes(db));
  app.use("/api", aiRoutes(db));
  if (dataDir) {
    app.use(
      "/api",
      dataRoutes({
        db,
        dataDir,
        migrationsDir: migrationsDir ?? path.resolve(process.cwd(), "..", "drizzle", "migrations"),
        version,
        recoveryKey,
      }),
    );
  }
  app.use("/api", transactionsRoutes(db));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    // Single-page app: any other GET returns the UI shell and the client-side router takes over.
    app.use((req, res, next) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) console.error(`request failed: ${err.code}`);
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "invalid_request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        error: "too_large",
        message: "That is too large to send. Try a smaller file or a shorter date range.",
      });
      return;
    }
    // Anything else is unexpected. Log the message only: request bodies and provider payloads
    // can contain financial data or secrets.
    console.error("request failed:", err instanceof Error ? err.message : "unknown error");
    const status = typeof err?.status === "number" && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 400 ? "bad_request" : "internal_error" });
  };
  app.use(onError);

  return app;
}
