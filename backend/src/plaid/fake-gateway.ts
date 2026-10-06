import crypto from "node:crypto";
import {
  PlaidGatewayError,
  type ExchangedItem,
  type GatewayAccount,
  type ItemStatus,
  type LinkToken,
  type LinkTokenRequest,
  type HoldingsSnapshot,
  type InvestmentTransactionsResult,
  type PlaidGateway,
  type TransactionSyncPage,
} from "./gateway.js";
import { DEFAULT_PAGE_SIZE, isoDate, pageLedger } from "./fake-ledger.js";
import { demoAccountValue, demoHoldings, demoInvestmentTransactions } from "./fake-investments.js";

/**
 * Built-in demo "Plaid". It needs no network and no keys, so the whole app can be built and used
 * before any real Plaid account exists. Identifiers embed what the gateway needs to answer later
 * calls (institution, item), so it keeps no database of its own and survives app restarts, apart
 * from the "simulate expired login" switch, which is in memory only.
 */

export interface FakeInstitution {
  id: string;
  name: string;
  accounts: Omit<GatewayAccount, "accountId">[];
}

export const FAKE_INSTITUTIONS: FakeInstitution[] = [
  {
    id: "ins_fake_bank",
    name: "First Platypus Bank",
    accounts: [
      account(
        "Plaid Checking",
        "Plaid Gold Standard 0% Interest Checking",
        "depository",
        "checking",
        "0000",
        110,
        100,
      ),
      account(
        "Plaid Saving",
        "Plaid Silver Standard 0.1% Interest Saving",
        "depository",
        "savings",
        "1111",
        210,
        200,
      ),
      account(
        "Plaid Credit Card",
        "Plaid Diamond 12.5% APR Interest Credit Card",
        "credit",
        "credit card",
        "3333",
        410,
        1590,
        2000,
      ),
    ],
  },
  {
    id: "ins_fake_brokerage",
    name: "Fake Brokerage",
    accounts: [account("Plaid 401k", "Plaid 401k", "investment", "401k", "6666", 23631.98, null)],
  },
  {
    id: "ins_fake_oauth",
    name: "First Platypus OAuth Bank",
    accounts: [
      account(
        "OAuth Checking",
        "OAuth Checking",
        "depository",
        "checking",
        "4444",
        1520.55,
        1500.55,
      ),
    ],
  },
];

function account(
  name: string,
  officialName: string,
  type: string,
  subtype: string,
  mask: string,
  currentBalance: number,
  availableBalance: number | null,
  creditLimit: number | null = null,
): Omit<GatewayAccount, "accountId"> {
  return {
    name,
    officialName,
    type,
    subtype,
    mask,
    currency: "USD",
    currentBalance,
    availableBalance,
    creditLimit,
  };
}

// Identifier layout: separators that cannot appear inside the institution ids above.
const PUBLIC_PREFIX = "public-fake~";
const ACCESS_PREFIX = "access-fake~";
const ITEM_PREFIX = "item-fake~";

function institutionOf(itemId: string): FakeInstitution | undefined {
  const [, institutionId] = itemId.split("~");
  return FAKE_INSTITUTIONS.find((i) => i.id === institutionId);
}

export interface FakeGatewayOptions {
  /** The current time; replaceable so tests can move the demo ledger forward day by day. */
  now?: () => Date;
  /** Transactions per page, small in tests to exercise pagination. */
  pageSize?: number;
}

export class FakePlaidGateway implements PlaidGateway {
  readonly environment = "fake" as const;
  /** Items currently simulating an expired login. */
  private readonly broken = new Set<string>();
  /** Credit limits changed through the demo tool, by item ID (decimal dollars). */
  private readonly limitOverrides = new Map<string, number>();
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(options: FakeGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  /** Test and demo helper: make an Item report that the user must log in again. */
  simulateLoginRequired(itemId: string): void {
    this.broken.add(itemId);
  }

  /** Test and demo helper: the bank changes the credit limit of an Item's credit card. */
  simulateCreditLimit(itemId: string, limit: number): void {
    this.limitOverrides.set(itemId, limit);
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<TransactionSyncPage> {
    const itemId = this.itemIdOf(accessToken);
    if (this.broken.has(itemId)) {
      throw new PlaidGatewayError(
        "ITEM_LOGIN_REQUIRED",
        "ITEM_ERROR",
        "The login details of this item have changed. The user must sign in again.",
      );
    }
    const institution = institutionOf(itemId);
    if (!institution)
      throw new PlaidGatewayError("ITEM_NOT_FOUND", "ITEM_ERROR", "Item not found.");
    try {
      return pageLedger(
        institution.id,
        institution.accounts.map((_, index) => ({
          accountId: `acct-fake~${itemId}~${index}`,
          index,
        })),
        cursor,
        isoDate(this.now()),
        this.pageSize,
      );
    } catch {
      throw new PlaidGatewayError(
        "INVALID_CURSOR",
        "INVALID_REQUEST",
        "The sync cursor is not valid.",
      );
    }
  }

  async createLinkToken(request: LinkTokenRequest): Promise<LinkToken> {
    const kind = request.updateAccessToken ? "update" : "new";
    return {
      linkToken: `link-fake~${kind}~${crypto.randomBytes(6).toString("hex")}`,
      expiration: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    };
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangedItem> {
    if (!publicToken.startsWith(PUBLIC_PREFIX)) {
      throw new PlaidGatewayError(
        "INVALID_PUBLIC_TOKEN",
        "INVALID_INPUT",
        "That public token is not valid.",
      );
    }
    const institutionId = publicToken.slice(PUBLIC_PREFIX.length).split("~")[0];
    if (!FAKE_INSTITUTIONS.some((i) => i.id === institutionId)) {
      throw new PlaidGatewayError(
        "INVALID_PUBLIC_TOKEN",
        "INVALID_INPUT",
        "Unknown demo institution.",
      );
    }
    const itemId = `${ITEM_PREFIX}${institutionId}~${crypto.randomBytes(5).toString("hex")}`;
    return { accessToken: `${ACCESS_PREFIX}${itemId}`, itemId };
  }

  async getItem(accessToken: string): Promise<ItemStatus> {
    const itemId = this.itemIdOf(accessToken);
    const institution = institutionOf(itemId);
    return {
      itemId,
      institutionId: institution?.id ?? null,
      error: this.broken.has(itemId)
        ? {
            code: "ITEM_LOGIN_REQUIRED",
            message: "The login details of this item have changed. The user must sign in again.",
          }
        : null,
    };
  }

  async getInstitutionName(institutionId: string): Promise<string | null> {
    return FAKE_INSTITUTIONS.find((i) => i.id === institutionId)?.name ?? null;
  }

  async getAccounts(accessToken: string): Promise<GatewayAccount[]> {
    const itemId = this.itemIdOf(accessToken);
    if (this.broken.has(itemId)) {
      throw new PlaidGatewayError(
        "ITEM_LOGIN_REQUIRED",
        "ITEM_ERROR",
        "The login details of this item have changed. The user must sign in again.",
      );
    }
    const institution = institutionOf(itemId);
    if (!institution)
      throw new PlaidGatewayError("ITEM_NOT_FOUND", "ITEM_ERROR", "Item not found.");
    const limitOverride = this.limitOverrides.get(itemId);
    const today = isoDate(this.now());
    return institution.accounts.map((a, index) => ({
      ...a,
      // An investment account is worth what it holds, so its balance follows the demo prices.
      currentBalance: a.type === "investment" ? demoAccountValue(today) : a.currentBalance,
      creditLimit:
        a.creditLimit !== null && limitOverride !== undefined ? limitOverride : a.creditLimit,
      accountId: `acct-fake~${itemId}~${index}`,
    }));
  }

  async getInvestmentHoldings(accessToken: string): Promise<HoldingsSnapshot> {
    const { institution, itemId } = this.requireWorkingItem(accessToken);
    const today = isoDate(this.now());
    const parts = institution.accounts.flatMap((a, index) =>
      a.type === "investment" ? [demoHoldings(`acct-fake~${itemId}~${index}`, today)] : [],
    );
    if (parts.length === 0) {
      throw new PlaidGatewayError(
        "PRODUCTS_NOT_SUPPORTED",
        "ITEM_ERROR",
        "This institution has no investment accounts.",
      );
    }
    return {
      holdings: parts.flatMap((p) => p.holdings),
      securities: parts[0]!.securities,
    };
  }

  async getInvestmentTransactions(
    accessToken: string,
    startDate: string,
    endDate: string,
  ): Promise<InvestmentTransactionsResult> {
    const { institution, itemId } = this.requireWorkingItem(accessToken);
    const parts = institution.accounts.flatMap((a, index) =>
      a.type === "investment"
        ? [demoInvestmentTransactions(`acct-fake~${itemId}~${index}`, startDate, endDate)]
        : [],
    );
    if (parts.length === 0) {
      throw new PlaidGatewayError(
        "PRODUCTS_NOT_SUPPORTED",
        "ITEM_ERROR",
        "This institution has no investment accounts.",
      );
    }
    return {
      transactions: parts.flatMap((p) => p.transactions),
      securities: parts[0]!.securities,
    };
  }

  private requireWorkingItem(accessToken: string): {
    institution: FakeInstitution;
    itemId: string;
  } {
    const itemId = this.itemIdOf(accessToken);
    if (this.broken.has(itemId)) {
      throw new PlaidGatewayError(
        "ITEM_LOGIN_REQUIRED",
        "ITEM_ERROR",
        "The login details of this item have changed. The user must sign in again.",
      );
    }
    const institution = institutionOf(itemId);
    if (!institution)
      throw new PlaidGatewayError("ITEM_NOT_FOUND", "ITEM_ERROR", "Item not found.");
    return { institution, itemId };
  }

  async removeItem(accessToken: string): Promise<void> {
    this.broken.delete(this.itemIdOf(accessToken));
  }

  async completeReauthentication(accessToken: string): Promise<void> {
    this.broken.delete(this.itemIdOf(accessToken));
  }

  private itemIdOf(accessToken: string): string {
    if (!accessToken.startsWith(ACCESS_PREFIX)) {
      throw new PlaidGatewayError(
        "INVALID_ACCESS_TOKEN",
        "INVALID_INPUT",
        "That access token is not valid.",
      );
    }
    return accessToken.slice(ACCESS_PREFIX.length);
  }
}
