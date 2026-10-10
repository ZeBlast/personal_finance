import {
  CountryCode,
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type Holding,
  type InvestmentTransaction,
  type Security,
  type Transaction,
} from "plaid";
import {
  PlaidGatewayError,
  type ExchangedItem,
  type GatewayAccount,
  type GatewayHolding,
  type GatewayInvestmentTransaction,
  type GatewaySecurity,
  type GatewayTransaction,
  type HoldingsSnapshot,
  type InvestmentTransactionKind,
  type InvestmentTransactionsResult,
  type TransactionSyncPage,
  type ItemStatus,
  type LinkToken,
  type LinkTokenRequest,
  type PlaidEnvironment,
  type PlaidGateway,
  type InstitutionBranding,
} from "./gateway.js";

const CLIENT_NAME = "Personal Finance";
const COUNTRY_CODES = [CountryCode.Us];

export function createPlaidApi(
  environment: "sandbox" | "production",
  clientId: string,
  secret: string,
): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[environment],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
          "Plaid-Version": "2020-09-14",
        },
        timeout: 30_000,
      },
    }),
  );
}

/**
 * Reduces any failure to a PlaidGatewayError. Plaid's HTTP errors carry a JSON body with an error
 * code and message; request configuration (which contains the secret and tokens) is never copied.
 */
export function toGatewayError(error: unknown): PlaidGatewayError {
  if (error instanceof PlaidGatewayError) return error;
  const data = (error as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (
    data &&
    typeof data["error_code"] === "string" &&
    typeof data["error_message"] === "string" &&
    /cursor/i.test(data["error_message"]) &&
    ["INVALID_FIELD", "INVALID_REQUEST", "INVALID_INPUT"].includes(data["error_code"])
  ) {
    // An invalid or expired sync cursor: the caller restarts from scratch and reconciles.
    // (Plaid does not document one dedicated code for this, so it is recognized by its message.)
    return new PlaidGatewayError(
      "INVALID_CURSOR",
      "INVALID_REQUEST",
      "The sync cursor is no longer valid.",
    );
  }
  if (data && typeof data["error_code"] === "string") {
    const message =
      (typeof data["display_message"] === "string" && data["display_message"]) ||
      (typeof data["error_message"] === "string" && data["error_message"]) ||
      "Plaid reported an error.";
    return new PlaidGatewayError(
      data["error_code"],
      typeof data["error_type"] === "string" ? data["error_type"] : "UNKNOWN",
      message,
    );
  }
  const code = (error as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    [
      "ECONNABORTED",
      "ENOTFOUND",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ERR_NETWORK",
    ].includes(code)
  ) {
    return new PlaidGatewayError(
      "NETWORK_ERROR",
      "NETWORK",
      "Could not reach Plaid. Check your internet connection.",
    );
  }
  return new PlaidGatewayError(
    "UNKNOWN_ERROR",
    "UNKNOWN",
    "Something went wrong talking to Plaid.",
  );
}

function mapAccount(account: AccountBase): GatewayAccount {
  const balances = account.balances;
  return {
    accountId: account.account_id,
    name: account.name,
    officialName: account.official_name ?? null,
    type: String(account.type),
    subtype: account.subtype ? String(account.subtype) : null,
    mask: account.mask ?? null,
    currency: balances.iso_currency_code ?? balances.unofficial_currency_code ?? "USD",
    currentBalance: balances.current ?? null,
    availableBalance: balances.available ?? null,
    creditLimit: balances.limit ?? null,
  };
}

function mapTransaction(t: Transaction): GatewayTransaction {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    pendingTransactionId: t.pending_transaction_id ?? null,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    amount: t.amount,
    currency: t.iso_currency_code ?? t.unofficial_currency_code ?? "USD",
    pending: t.pending,
    paymentChannel: t.payment_channel ? String(t.payment_channel) : null,
    categoryPrimary: t.personal_finance_category?.primary ?? null,
    categoryDetailed: t.personal_finance_category?.detailed ?? null,
    counterparties: (t.counterparties ?? []).map((c) => ({
      name: c.name,
      type: String(c.type),
      entityId: c.entity_id ?? null,
      website: c.website ?? null,
      logoUrl: c.logo_url ?? null,
      confidenceLevel: c.confidence_level ?? null,
    })),
    paymentPayee: t.payment_meta?.payee ?? null,
    paymentPayer: t.payment_meta?.payer ?? null,
    datetime: t.datetime ?? null,
    authorizedDatetime: t.authorized_datetime ?? null,
    originalDescription: t.original_description ?? null,
    location: t.location
      ? {
          address: t.location.address ?? null,
          city: t.location.city ?? null,
          region: t.location.region ?? null,
          postalCode: t.location.postal_code ?? null,
          country: t.location.country ?? null,
          lat: t.location.lat ?? null,
          lon: t.location.lon ?? null,
          storeNumber: t.location.store_number ?? null,
        }
      : null,
    merchantEntityId: t.merchant_entity_id ?? null,
    merchantCategoryCode: t.merchant_category_code ?? null,
    logoUrl: t.logo_url ?? null,
    website: t.website ?? null,
    categoryConfidence: t.personal_finance_category?.confidence_level ?? null,
    payment: t.payment_meta
      ? {
          method: t.payment_meta.payment_method ?? null,
          processor: t.payment_meta.payment_processor ?? null,
          reference: t.payment_meta.reference_number ?? null,
          reason: t.payment_meta.reason ?? null,
          byOrderOf: t.payment_meta.by_order_of ?? null,
          ppdId: t.payment_meta.ppd_id ?? null,
        }
      : null,
  };
}

function mapSecurity(s: Security): GatewaySecurity {
  return {
    securityId: s.security_id,
    symbol: s.ticker_symbol ?? null,
    name: s.name ?? s.ticker_symbol ?? "Unknown security",
    type: s.type ?? null,
    currency: s.iso_currency_code ?? s.unofficial_currency_code ?? "USD",
    subtype: s.subtype ?? null,
    isin: s.isin ?? null,
    cusip: s.cusip ?? null,
    sedol: s.sedol ?? null,
    figi: s.figi ?? null,
    cfiCode: s.cfi_code ?? null,
    institutionSecurityId: s.institution_security_id ?? null,
    proxySecurityId: s.proxy_security_id ?? null,
    marketIdentifierCode: s.market_identifier_code ?? null,
    isCashEquivalent: s.is_cash_equivalent ?? null,
    closePrice: s.close_price ?? null,
    closePriceAsOf: s.close_price_as_of ?? null,
    sector: s.sector ?? null,
    industry: s.industry ?? null,
    updatedAt: s.update_datetime ?? null,
    option: s.option_contract
      ? {
          contractType: s.option_contract.contract_type ?? null,
          expiration: s.option_contract.expiration_date ?? null,
          strike: s.option_contract.strike_price ?? null,
          underlying: s.option_contract.underlying_security_ticker ?? null,
        }
      : null,
    fixedIncome: s.fixed_income
      ? {
          yieldRate: s.fixed_income.yield_rate?.percentage ?? null,
          yieldType: s.fixed_income.yield_rate?.type
            ? String(s.fixed_income.yield_rate.type)
            : null,
          maturityDate: s.fixed_income.maturity_date ?? null,
          issueDate: s.fixed_income.issue_date ?? null,
          faceValue: s.fixed_income.face_value ?? null,
        }
      : null,
    raw: s,
  };
}

function mapHolding(h: Holding): GatewayHolding {
  return {
    accountId: h.account_id,
    securityId: h.security_id,
    quantity: h.quantity,
    price: h.institution_price,
    value: h.institution_value,
    costBasis: h.cost_basis ?? null,
    currency: h.iso_currency_code ?? h.unofficial_currency_code ?? "USD",
    asOf: h.institution_price_datetime ?? h.institution_price_as_of ?? null,
    vestedQuantity: h.vested_quantity ?? null,
    vestedValue: h.vested_value ?? null,
    priceAsOf: h.institution_price_as_of ?? null,
    priceDatetime: h.institution_price_datetime ?? null,
    raw: h,
  };
}

/** Plaid describes an investment transaction by a type and a subtype; this keeps one plain word. */
export function investmentKind(type: string, subtype: string): InvestmentTransactionKind {
  const sub = subtype.toLowerCase();
  if (type === "buy") return "buy";
  if (type === "sell") return "sell";
  if (type === "fee") return "fee";
  if (sub.includes("dividend")) return "dividend";
  if (sub.includes("interest")) return "interest";
  if (sub === "contribution" || sub === "deposit") return "contribution";
  if (sub === "withdrawal" || sub === "distribution") return "withdrawal";
  if (type === "transfer") return "transfer";
  return "other";
}

function mapInvestmentTransaction(t: InvestmentTransaction): GatewayInvestmentTransaction {
  return {
    transactionId: t.investment_transaction_id,
    accountId: t.account_id,
    securityId: t.security_id ?? null,
    date: t.date,
    name: t.name,
    kind: investmentKind(String(t.type), String(t.subtype)),
    quantity: t.quantity === 0 ? null : t.quantity,
    price: t.price === 0 ? null : t.price,
    amount: t.amount,
    fees: t.fees ?? null,
    currency: t.iso_currency_code ?? t.unofficial_currency_code ?? "USD",
    subtype: t.subtype ? String(t.subtype) : null,
    datetime: t.transaction_datetime ?? null,
    cancelTransactionId: t.cancel_transaction_id ?? null,
    raw: t,
  };
}

export class RealPlaidGateway implements PlaidGateway {
  constructor(
    readonly environment: Exclude<PlaidEnvironment, "fake">,
    private readonly api: PlaidApi,
  ) {}

  async createLinkToken(request: LinkTokenRequest): Promise<LinkToken> {
    try {
      const base = {
        user: { client_user_id: request.userId },
        client_name: CLIENT_NAME,
        language: "en",
        country_codes: COUNTRY_CODES,
      };
      // Update mode (re-authentication) passes the existing access token and no products.
      // A brokerage is linked on its own with only Investments: Plaid lists only institutions that
      // support every product in `products`, and brokerages such as Fidelity have no Transactions.
      // A bank also asks for Investments as an optional extra, which costs nothing unless used.
      const body = request.updateAccessToken
        ? { ...base, access_token: request.updateAccessToken }
        : request.kind === "investments"
          ? { ...base, products: [Products.Investments] }
          : {
              ...base,
              products: [Products.Transactions],
              optional_products: [Products.Investments],
              // Fixed when the Item is created and cannot be raised later.
              transactions: { days_requested: request.daysRequested },
            };
      const response = await this.api.linkTokenCreate(body);
      return { linkToken: response.data.link_token, expiration: response.data.expiration };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionSyncPage> {
    try {
      const { data } = await this.api.transactionsSync({
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: 500,
        // The original description (the bank's own wording) is only sent when asked for.
        options: { include_personal_finance_category: true, include_original_description: true },
      });
      return {
        added: data.added.map(mapTransaction),
        modified: data.modified.map(mapTransaction),
        removedIds: data.removed.map((r) => r.transaction_id).filter((id): id is string => !!id),
        nextCursor: data.next_cursor,
        hasMore: data.has_more,
      };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getInvestmentHoldings(accessToken: string): Promise<HoldingsSnapshot> {
    try {
      const { data } = await this.api.investmentsHoldingsGet({ access_token: accessToken });
      return {
        holdings: data.holdings.map(mapHolding),
        securities: data.securities.map(mapSecurity),
      };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getInvestmentTransactions(
    accessToken: string,
    startDate: string,
    endDate: string,
  ): Promise<InvestmentTransactionsResult> {
    try {
      const transactions: GatewayInvestmentTransaction[] = [];
      const securities = new Map<string, GatewaySecurity>();
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data } = await this.api.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: pageSize, offset },
        });
        transactions.push(...data.investment_transactions.map(mapInvestmentTransaction));
        for (const s of data.securities) securities.set(s.security_id, mapSecurity(s));
        if (
          data.investment_transactions.length === 0 ||
          transactions.length >= data.total_investment_transactions
        ) {
          break;
        }
      }
      return { transactions, securities: [...securities.values()] };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangedItem> {
    try {
      const response = await this.api.itemPublicTokenExchange({ public_token: publicToken });
      return { accessToken: response.data.access_token, itemId: response.data.item_id };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getItem(accessToken: string): Promise<ItemStatus> {
    try {
      const { item } = (await this.api.itemGet({ access_token: accessToken })).data;
      return {
        itemId: item.item_id,
        institutionId: item.institution_id ?? null,
        error: item.error
          ? {
              code: item.error.error_code,
              message: item.error.display_message ?? item.error.error_message,
            }
          : null,
      };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getInstitutionName(institutionId: string): Promise<string | null> {
    try {
      const response = await this.api.institutionsGetById({
        institution_id: institutionId,
        country_codes: COUNTRY_CODES,
      });
      return response.data.institution.name;
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getInstitutionBranding(institutionId: string): Promise<InstitutionBranding> {
    try {
      const response = await this.api.institutionsGetById({
        institution_id: institutionId,
        country_codes: COUNTRY_CODES,
        options: { include_optional_metadata: true },
      });
      const institution = response.data.institution;
      // Plaid sends the logo as a base64 PNG.
      const logo = institution.logo ? `data:image/png;base64,${institution.logo}` : null;
      const color = institution.primary_color ?? null;
      return { logo, color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : null };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async getAccounts(accessToken: string): Promise<GatewayAccount[]> {
    try {
      const response = await this.api.accountsGet({ access_token: accessToken });
      return response.data.accounts.map(mapAccount);
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async removeItem(accessToken: string): Promise<void> {
    try {
      await this.api.itemRemove({ access_token: accessToken });
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async completeReauthentication(): Promise<void> {
    // Nothing to do: after update-mode Link succeeds, Plaid itself marks the Item healthy, and
    // no public-token exchange is needed. The next status check or sync confirms it.
  }
}
