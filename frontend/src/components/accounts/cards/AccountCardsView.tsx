import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePersistentState } from "../../../hooks/usePersistentState";
import { Modal } from "../../common/Modal";
import { LimitHistory } from "../LimitHistory";
import { applyOrder, moveBefore } from "./order";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../../../api/client";
import { useApi } from "../../../hooks/useApi";
import { useCategories } from "../../../hooks/useCategories";
import { formatMinor } from "../../../lib/money";
import { announceDataChanged, announceSyncFinished } from "../../../lib/syncEvents";
import { timeAgo } from "../../../lib/time";
import type { Account, PlaidItem } from "../../../types/api";
import { ManualTransactionDialog } from "../../transactions/ManualTransactionDialog";
import { BankCsvImportDialog } from "../BankCsvImportDialog";
import { CollectionDialog, isCollection } from "../CollectionDialog";
import { CollectionShowcase } from "./CollectionShowcase";
import { dayOfMonth, StatementsDialog } from "../StatementsDialog";

/**
 * The experimental Accounts view: every account as a card in the style of the investment account
 * cards, with the account's colour as an accent down the left side. Cards are grouped by the bank
 * they come from (each group with its own Sync button), accounts kept by hand together after
 * them, and the grid fills the width of the window. A card shows the account's name, its number's
 * last digits, its balance (with how much of the limit is used for a credit card) and whether it
 * is connected, needs attention, or is kept by hand; click it to turn it over for the details and
 * what you can do. Collections get a showcase of their own (see CollectionShowcase).
 */
export function AccountCardsView({ items }: { items: PlaidItem[] }) {
  const accounts = useApi<Account[]>("/accounts?includeHidden=1");
  const { categories } = useCategories();
  const [adding, setAdding] = useState<Account | null>(null);
  const [importing, setImporting] = useState<Account | null>(null);
  const [managing, setManaging] = useState<Account | null>(null);
  const [statementsOf, setStatementsOf] = useState<Account | null>(null);
  const [limitsOf, setLimitsOf] = useState<Account | null>(null);
  // The user's order of banks and of cards (dragged into place), remembered in this browser.
  const [groupOrder, setGroupOrder] = usePersistentState<string[]>("pf.accounts.groupOrder", []);
  const [cardOrder, setCardOrder] = usePersistentState<string[]>("pf.accounts.cardOrder", []);

  const all = accounts.data ?? [];
  const collections = all.filter(isCollection);
  const manual = all.filter((a) => a.isManual && !isCollection(a));
  const manualBank = manual.filter((a) => a.type === "depository" || a.type === "credit");
  // One group per connection, in the order the connections were made.
  const groups = useMemo(
    () =>
      items
        .map((item) => ({ item, accounts: all.filter((a) => a.itemId === item.id) }))
        .filter((g) => g.accounts.length > 0),
    [items, all],
  );
  const changed = () => {
    setAdding(null);
    setImporting(null);
    accounts.reload();
    announceDataChanged();
  };

  if (accounts.error) return <p className="text-sm text-red-600">{accounts.error}</p>;
  if (!accounts.data) return <p className="text-sm text-slate-500">Loading your accounts...</p>;

  const orderedGroups = applyOrder(groups, (g) => `item-${g.item.id}`, groupOrder);
  const cardsIn = (list: Account[]) => applyOrder(list, (a) => String(a.id), cardOrder);

  /** Cards of one group, in the user's order, each draggable within the group. */
  const cardsOf = (groupKey: string, list: Account[]) => {
    const ordered = cardsIn(list);
    return ordered.map((a) => (
      <Draggable
        key={a.id}
        kind="card"
        id={String(a.id)}
        scope={groupKey}
        onMove={(from) =>
          setCardOrder(
            moveBefore(
              ordered.map((x) => String(x.id)),
              from,
              String(a.id),
            ).concat(cardOrder.filter((k) => !ordered.some((x) => String(x.id) === k))),
          )
        }
      >
        <AccountCard
          account={a}
          onAdd={() => setAdding(a)}
          onImport={() => setImporting(a)}
          onStatements={() => setStatementsOf(a)}
          onLimits={() => setLimitsOf(a)}
        />
      </Draggable>
    ));
  };

  return (
    <div className="space-y-8">
      {collections.length > 0 && (
        <section className="space-y-4">
          <GroupHeading title="Collections" subtitle="Valued item by item" />
          {collections.map((a) => (
            <CollectionShowcase key={a.id} account={a} onManage={() => setManaging(a)} />
          ))}
        </section>
      )}

      {/* Groups sit side by side while the window has room, each as wide as its cards. */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-8">
        {manual.length > 0 && (
          <GroupBox count={manual.length}>
            <GroupHeading title="Kept by hand" subtitle="Accounts you add and update yourself" />
            <CardGrid>{cardsOf("manual", manual)}</CardGrid>
          </GroupBox>
        )}
        {orderedGroups.map(({ item, accounts: own }) => (
          <Draggable
            key={item.id}
            kind="group"
            id={`item-${item.id}`}
            scope="banks"
            handleOnly
            style={groupBasis(own.length)}
            onMove={(from) =>
              setGroupOrder(
                moveBefore(
                  orderedGroups.map((g) => `item-${g.item.id}`),
                  from,
                  `item-${item.id}`,
                ),
              )
            }
          >
            <InstitutionGroup item={item}>{cardsOf(`item-${item.id}`, own)}</InstitutionGroup>
          </Draggable>
        ))}
      </div>

      {groups.length === 0 && manual.length === 0 && (
        <p className="text-sm text-slate-500">No accounts yet.</p>
      )}

      {limitsOf && (
        <Modal
          title={`${limitsOf.name}: credit limit`}
          onClose={() => {
            setLimitsOf(null);
            accounts.reload();
          }}
          wide
          dismissible
        >
          <p className="mb-2 text-sm text-slate-500">
            Current limit: {money(limitsOf, limitsOf.creditLimitMinor)}. Add, change or remove
            entries; the current limit is the newest one.
          </p>
          <LimitHistory account={limitsOf} defaultOpen />
        </Modal>
      )}

      {adding && (
        <ManualTransactionDialog
          accounts={manualBank}
          categories={categories ?? []}
          defaultAccountId={adding.id}
          onSaved={changed}
          onClose={() => setAdding(null)}
        />
      )}
      {importing && (
        <BankCsvImportDialog
          account={importing}
          onDone={changed}
          onClose={() => setImporting(null)}
        />
      )}
      {statementsOf && (
        <StatementsDialog
          account={statementsOf}
          onClose={() => {
            setStatementsOf(null);
            accounts.reload();
          }}
        />
      )}
      {managing && (
        <CollectionDialog
          account={managing}
          onChanged={() => {
            accounts.reload();
            announceDataChanged();
          }}
          onClose={() => setManaging(null)}
        />
      )}
    </div>
  );
}

/**
 * How wide a group starts: room for all its cards in a row (17rem each, 1rem apart), so groups
 * with few cards sit side by side; it can grow to fill a line and wraps when there is no room.
 */
const groupBasis = (cards: number): CSSProperties => ({
  flex: `1 1 calc(${cards} * 17rem + ${Math.max(0, cards - 1)} * 1rem)`,
  maxWidth: "100%",
  minWidth: "17rem",
});

function GroupBox({ count, children }: { count: number; children: ReactNode }) {
  return <section style={groupBasis(count)}>{children}</section>;
}

/** What is being dragged right now (drag events can't read their data until the drop). */
let dragging: { kind: string; scope: string; id: string } | null = null;

/**
 * Something that can be dragged onto another of its kind (and scope: a card stays in its bank)
 * to take its place. With `handleOnly`, the drag starts only from an element marked
 * `data-drag-handle` inside it, so buttons and cards inside still work as usual.
 */
function Draggable({
  kind,
  id,
  scope,
  handleOnly,
  style,
  onMove,
  children,
}: {
  kind: string;
  id: string;
  scope: string;
  handleOnly?: boolean;
  style?: CSSProperties;
  onMove: (fromId: string) => void;
  children: ReactNode;
}) {
  // Whether the press began on the handle. The browser decides at the press whether something can
  // be dragged, so the element is always draggable and a drag not from the handle is cancelled.
  const fromHandle = useRef(!handleOnly);
  const [over, setOver] = useState(false);
  const [lifted, setLifted] = useState(false);
  const accepts = () =>
    dragging !== null && dragging.kind === kind && dragging.scope === scope && dragging.id !== id;
  return (
    <div
      style={style}
      draggable
      onPointerDown={(e) => {
        if (handleOnly) {
          fromHandle.current = (e.target as HTMLElement).closest("[data-drag-handle]") !== null;
        }
      }}
      onDragStart={(e) => {
        // A card inside a bank being dragged is its own drag (started on it, handled above).
        if (e.target !== e.currentTarget) return;
        if (!fromHandle.current) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        dragging = { kind, scope, id };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        setLifted(true);
      }}
      onDragEnd={() => {
        dragging = null;
        setLifted(false);
        if (handleOnly) fromHandle.current = false;
      }}
      onDragOver={(e) => {
        if (!accepts()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts()) return;
        e.preventDefault();
        e.stopPropagation();
        onMove(dragging!.id);
      }}
      className={`rounded-lg transition ${lifted ? "opacity-40" : ""} ${
        over ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-slate-900" : ""
      }`}
    >
      {children}
    </div>
  );
}

/** The cards fill the width of the window: as many columns as fit, each at least 17rem. */
function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(17rem, 1fr))" }}
    >
      {children}
    </div>
  );
}

/** A group's name, with its actions right beside it on the left (not pushed to the far side). */
function GroupHeading({
  title,
  subtitle,
  logo,
  action,
  draggable,
}: {
  title: string;
  subtitle: string;
  logo?: string | null;
  action?: ReactNode;
  /** Shows a grip to drag the group by. */
  draggable?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      {draggable && (
        <span
          data-drag-handle
          title="Drag to move this bank"
          className="cursor-grab px-0.5 text-lg leading-none text-slate-400 select-none hover:text-slate-600 active:cursor-grabbing dark:hover:text-slate-200"
        >
          ⠿
        </span>
      )}
      {logo ? (
        <img
          src={logo}
          alt=""
          data-drag-handle={draggable || undefined}
          className="h-8 w-8 rounded-full bg-white object-contain p-0.5 ring-1 ring-slate-200"
        />
      ) : null}
      <div className="min-w-0" data-drag-handle={draggable || undefined}>
        <h2 className="truncate text-lg font-semibold">{title}</h2>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

/** A bank's accounts, with a button that syncs just that bank. */
function InstitutionGroup({ item, children }: { item: PlaidItem; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{
        runs: Array<{
          status: string;
          added: number;
          modified: number;
          errorMessage: string | null;
        }>;
      }>("/sync", { method: "POST", body: JSON.stringify({ itemId: item.id }) });
      const run = result.runs[0];
      setMessage(
        !run
          ? "Nothing to sync."
          : run.status === "success"
            ? run.added + run.modified > 0
              ? `Synced: ${run.added} new, ${run.modified} updated.`
              : "Synced. Nothing new."
            : (run.errorMessage ?? "The sync did not finish."),
      );
    } catch (e) {
      setMessage(errorMessage(e, "Could not sync."));
    } finally {
      setBusy(false);
      announceSyncFinished();
    }
  }

  const status =
    item.status === "active"
      ? item.lastSuccessfulSyncAt
        ? `Synced ${timeAgo(item.lastSuccessfulSyncAt)}`
        : "Not synced yet"
      : item.status === "login_required"
        ? "Needs you to sign in again (reconnect in the classic view)"
        : "Connection problem";

  return (
    <section>
      <GroupHeading
        title={item.institutionName}
        subtitle={status}
        logo={item.logo}
        draggable
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || item.borrowed}
              onClick={() => void sync()}
              className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-800"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              >
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {busy ? "Syncing..." : "Sync"}
            </button>
            {message && <span className="text-xs text-slate-500">{message}</span>}
          </div>
        }
      />
      <CardGrid>{children}</CardGrid>
    </section>
  );
}

const money = (a: Account, minor: number | null) => formatMinor(minor, a.currency || "USD");

/** A plain outline of a card chip, drawn in the text colour. */
function ChipOutline() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 40 30"
      className="h-6 w-8 text-slate-400 dark:text-slate-500"
    >
      <rect
        x="1"
        y="1"
        width="38"
        height="28"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M1 11h11M1 19h11M28 11h11M28 19h11M12 1v28M28 1v28M12 15h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/** Connected, needs attention, or kept by hand. */
function Status({ account: a }: { account: Account }) {
  if (a.isManual) {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300">
        Manual
      </span>
    );
  }
  const ok = a.connectionStatus === "active";
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
        ok
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      {ok ? "Connected" : "Disconnected"}
    </span>
  );
}

const KIND: Record<string, string> = {
  credit: "Credit card",
  depository: "Bank account",
  loan: "Loan",
  investment: "Investments",
};

function AccountCard({
  account: a,
  onAdd,
  onImport,
  onStatements,
  onLimits,
}: {
  account: Account;
  onAdd: () => void;
  onImport: () => void;
  onStatements: () => void;
  onLimits: () => void;
}) {
  const navigate = useNavigate();
  const [flipped, setFlipped] = useState(false);
  const color = a.color ?? "#94a3b8";
  const payment = a.type === "credit" || a.type === "depository";
  const credit = a.type === "credit";
  const limit = credit ? a.creditLimitMinor : null;
  const used =
    limit && limit > 0 ? Math.min(1, Math.max(0, (a.currentBalanceMinor ?? 0) / limit)) : null;
  const kind = a.subtype
    ? `${a.subtype[0]!.toUpperCase()}${a.subtype.slice(1)}`
    : (KIND[a.type] ?? a.type);

  // Hovering lights the card up, like a day on the calendar.
  const faceClass =
    "absolute inset-0 flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white p-3 pl-4 text-sm transition-colors group-hover/card:border-slate-300 group-hover/card:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:group-hover/card:border-slate-600 dark:group-hover/card:bg-slate-800";
  const hidden = {
    backfaceVisibility: "hidden" as const,
    WebkitBackfaceVisibility: "hidden" as const,
  };
  const accent = (
    <span
      aria-hidden="true"
      className="absolute inset-y-0 left-0 w-1.5"
      style={{ backgroundColor: color }}
    />
  );

  return (
    <div className={`group/card [perspective:1200px] ${a.hidden ? "opacity-50" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={`${a.name}: ${flipped ? "showing details, click to turn back" : "click for details"}`}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((f) => !f);
          }
        }}
        className="relative h-44 w-full cursor-pointer rounded-md shadow-sm transition-[transform,box-shadow] duration-500 outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-blue-500"
        style={{ transformStyle: "preserve-3d", transform: `rotateY(${flipped ? 180 : 0}deg)` }}
      >
        {/* Front. */}
        <div className={faceClass} style={hidden}>
          {accent}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{a.name}</div>
              <div className="text-xs text-slate-500">
                {kind}
                {a.hidden ? " · hidden" : ""}
              </div>
            </div>
            <Status account={a} />
          </div>
          <div className="mt-2 flex items-center gap-3">
            {payment && <ChipOutline />}
            {a.mask && (
              <span className="font-mono text-sm tracking-[0.2em] text-slate-500">
                •••• {a.mask}
              </span>
            )}
          </div>
          <div className="mt-auto">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-slate-500">{credit ? "Balance owed" : "Balance"}</span>
              <span className="text-lg font-semibold tabular-nums">
                {money(a, a.currentBalanceMinor)}
              </span>
            </div>
            {credit && (
              <div className="mt-1">
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
                  title={
                    used === null
                      ? "No limit known"
                      : `${Math.round(used * 100)}% of the limit used`
                  }
                >
                  <div
                    className={`h-full rounded-full ${used !== null && used > 0.5 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${(used ?? 0) * 100}%` }}
                  />
                </div>
                <div className="mt-0.5 flex justify-between text-xs text-slate-500">
                  <span>
                    {used === null ? "" : `${Math.round(used * 100)}% used`}
                    {a.statementClosingDay
                      ? `${used === null ? "" : " · "}closes ${dayOfMonth(a.statementClosingDay)}`
                      : ""}
                  </span>
                  <span>{limit ? `Limit ${money(a, limit)}` : "No limit known"}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Back. */}
        <div className={faceClass} style={{ ...hidden, transform: "rotateY(180deg)" }}>
          {accent}
          <div className="truncate font-medium">{a.name}</div>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {a.officialName && a.officialName !== a.name && (
              <>
                <dt className="text-slate-500">Official name</dt>
                <dd className="truncate text-right">{a.officialName}</dd>
              </>
            )}
            {credit
              ? // The bank's own figure when it gives one, else what the limit leaves.
                (a.availableBalanceMinor !== null || limit !== null) && (
                  <>
                    <dt className="text-slate-500">Available credit</dt>
                    <dd className="text-right tabular-nums">
                      {money(
                        a,
                        a.availableBalanceMinor ??
                          Math.max(0, limit! - (a.currentBalanceMinor ?? 0)),
                      )}
                    </dd>
                  </>
                )
              : a.availableBalanceMinor !== null && (
                  <>
                    <dt className="text-slate-500">Available</dt>
                    <dd className="text-right tabular-nums">{money(a, a.availableBalanceMinor)}</dd>
                  </>
                )}
            {credit && (
              <>
                <dt className="text-slate-500">Credit limit</dt>
                <dd className="text-right tabular-nums">
                  {limit !== null ? money(a, limit) : "not known"}
                </dd>
              </>
            )}
          </dl>
          <div className="mt-auto flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
            <BackButton onClick={() => navigate(`/transactions?account=${a.id}`)}>
              Transactions
            </BackButton>
            {credit && <BackButton onClick={onStatements}>Statements</BackButton>}
            {credit && <BackButton onClick={onLimits}>Credit limit</BackButton>}
            {a.isManual && payment && (
              <>
                <BackButton onClick={onAdd}>Add transaction</BackButton>
                <BackButton onClick={onImport}>Import CSV</BackButton>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BackButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(e) => e.stopPropagation()}
      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}
