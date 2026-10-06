import type { PlaidApi } from "plaid";
import type { AppDb } from "../db/client.js";
import { loadPlaidCredentials } from "../services/credentials.service.js";
import type { TokenCipher } from "../services/crypto.js";
import { getSettings } from "../services/settings.service.js";
import { AppError } from "../utils/errors.js";
import { FakePlaidGateway } from "./fake-gateway.js";
import type { PlaidGateway } from "./gateway.js";
import { createPlaidApi, RealPlaidGateway } from "./real-gateway.js";

/** Returns the gateway for the environment currently selected in Settings. */
export type GatewayProvider = () => PlaidGateway;

type ApiFactory = (
  environment: "sandbox" | "production",
  clientId: string,
  secret: string,
) => PlaidApi;

export function createGatewayProvider(
  db: AppDb,
  cipher: TokenCipher,
  apiFactory: ApiFactory = createPlaidApi,
): GatewayProvider {
  const fake = new FakePlaidGateway();
  let cached: { signature: string; gateway: PlaidGateway } | null = null;

  return () => {
    const environment = getSettings(db).plaidEnvironment;
    if (environment === "fake") return fake;

    const creds = loadPlaidCredentials(db, cipher, environment);
    if (!creds) {
      throw new AppError(
        409,
        "plaid_not_configured",
        `Enter your Plaid ${environment} client ID and secret in Settings first.`,
      );
    }
    const signature = `${environment}\n${creds.clientId}\n${creds.secret}`;
    if (cached?.signature !== signature) {
      cached = {
        signature,
        gateway: new RealPlaidGateway(
          environment,
          apiFactory(environment, creds.clientId, creds.secret),
        ),
      };
    }
    return cached.gateway;
  };
}
