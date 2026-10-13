import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePersistentState } from "../../../hooks/usePersistentState";
import { Modal } from "../../common/Modal";
import { LimitHistory } from "../LimitHistory";
import { applyOrder, moveBeside, moveToNewRow, normalizeRows } from "./order";
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
  // How the user arranged the groups (in rows) and the cards (dragged into place), remembered in
  // this browser. The older one-line order of banks seeds the rows until they are first arranged.
  const [groupOrder] = usePersistentState<string[]>("pf.accounts.groupOrder", []);
  const [groupRows, setGroupRows] = usePersistentState<string[][]>("pf.accounts.groupRows", []);
  const [cardOrder, setCardOrder] = usePersistentState<string[]>("pf.accounts.cardOrder", []);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragNow = useRef<Drag | null>(null);
  /** Applies a finished drag; set each render so it sees the current rows and cards. */
  const dropRef = useRef<(d: Drag) => void>(() => {});

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

  const groupKey = (g: { item: PlaidItem }) => `item-${g.item.id}`;
  const byKey = new Map(groups.map((g) => [groupKey(g), g]));
  const keys = [
    ...(manual.length > 0 ? ["manual"] : []),
    ...applyOrder(groups, groupKey, groupOrder).map(groupKey),
  ];
  const rows = normalizeRows(groupRows, keys);
  /** Each group's cards in the user's order. */
  const cardsByGroup = new Map<string, Account[]>([
    ["manual", applyOrder(manual, (a) => String(a.id), cardOrder)],
    ...groups.map((g): [string, Account[]] => [
      groupKey(g),
      applyOrder(g.accounts, (a) => String(a.id), cardOrder),
    ]),
  ]);

  dropRef.current = (d) => {
    const t = d.target;
    if (!t) return;
    if (t.type === "row") setGroupRows(moveToNewRow(rows, d.key, t.index));
    else if (t.type === "beside") setGroupRows(moveBeside(rows, d.key, t.key, t.side));
    else {
      const ids = (cardsByGroup.get(d.scope) ?? []).map((a) => String(a.id));
      const next = moveBeside([ids], d.key, t.id, t.side)[0] ?? ids;
      setCardOrder(next.concat(cardOrder.filter((k) => !next.includes(k))));
    }
  };
  const show = (d: Drag | null) => {
    dragNow.current = d;
    setDrag(d);
  };

  /**
   * A press that may become a drag: on a group's grip, name or logo it moves the group; on a card,
   * the card (within its group). It only becomes a drag once the pointer has moved a little, so a
   * plain click still turns a card over. Pointer events, not the browser's drag and drop, which
   * the desktop window takes for dropping files.
   */
  const onPress = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, a, input, select, textarea")) return;
    const group = el.closest("[data-drag-handle]")?.closest<HTMLElement>("[data-group-key]");
    const card = el.closest<HTMLElement>("[data-card-id]");
    const what: Pick<Drag, "kind" | "key" | "scope" | "label"> | null = group
      ? {
          kind: "group",
          key: group.dataset.groupKey!,
          scope: "groups",
          label: group.dataset.label ?? "",
        }
      : card
        ? {
            kind: "card",
            key: card.dataset.cardId!,
            scope: card.dataset.cardScope!,
            label: card.dataset.label ?? "",
          }
        : null;
    if (!what) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        moving = true;
        document.body.style.userSelect = "none";
      }
      ev.preventDefault();
      show({
        ...what,
        x: ev.clientX,
        y: ev.clientY,
        target: dropTarget(what, ev.clientX, ev.clientY),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!moving) return;
      document.body.style.userSelect = "";
      const d = dragNow.current;
      show(null);
      if (d) dropRef.current(d);
      // The click that ends a drag must not also turn a card over.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Cards of one group, in the user's order, each draggable within the group. */
  const cardsOf = (scope: string) =>
    (cardsByGroup.get(scope) ?? []).map((a) => {
      const id = String(a.id);
      const mark = drag?.target?.type === "card" && drag.target.id === id ? drag.target.side : null;
      return (
        <div
          key={a.id}
          data-card-id={id}
          data-card-scope={scope}
          data-label={a.name}
          className={`relative ${drag?.kind === "card" && drag.key === id ? "opacity-40" : ""}`}
        >
          {mark && <DropBar side={mark} gap="0.5rem" />}
          <AccountCard
            account={a}
            onAdd={() => setAdding(a)}
            onImport={() => setImporting(a)}
            onStatements={() => setStatementsOf(a)}
            onLimits={() => setLimitsOf(a)}
          />
        </div>
      );
    });

  const groupBox = (key: string) => {
    const g = byKey.get(key);
    const count = key === "manual" ? manual.length : (g?.accounts.length ?? 0);
    const mark =
      drag?.target?.type === "beside" && drag.target.key === key ? drag.target.side : null;
    return (
      <section
        key={key}
        data-group-key={key}
        data-label={g ? g.item.institutionName : "Kept by hand"}
        style={groupBasis(count)}
        className={`relative ${drag?.kind === "group" && drag.key === key ? "opacity-40" : ""}`}
      >
        {mark && <DropBar side={mark} gap="1rem" />}
        {g ? (
          <InstitutionGroup item={g.item}>{cardsOf(key)}</InstitutionGroup>
        ) : (
          <>
            <GroupHeading
              title="Kept by hand"
              subtitle="Accounts you add and update yourself"
              draggable
            />
            <CardGrid>{cardsOf("manual")}</CardGrid>
          </>
        )}
      </section>
    );
  };
  const movingGroup = drag?.kind === "group";
  const slot = (index: number, edge: boolean) => (
    <RowSlot
      index={index}
      showing={movingGroup}
      edge={edge}
      targeted={drag?.target?.type === "row" && drag.target.index === index}
    />
  );

  return (
    <div className="space-y-8" onPointerDown={onPress}>
      {collections.length > 0 && (
        <section className="space-y-4">
          <GroupHeading title="Collections" subtitle="Valued item by item" />
          {collections.map((a) => (
            <CollectionShowcase key={a.id} account={a} onManage={() => setManaging(a)} />
          ))}
        </section>
      )}

      {/* Groups in the rows the user arranged; in a row they sit side by side while there is
          room, each as wide as its cards. Moving a group shows places for a line of its own. */}
      <div>
        {rows.map((row, i) => (
          <Fragment key={row.join(" ")}>
            {slot(i, i === 0)}
            <div
              data-row-last={row[row.length - 1]}
              className="flex flex-wrap items-start gap-x-8 gap-y-8"
            >
              {row.map(groupBox)}
            </div>
          </Fragment>
        ))}
        {rows.length > 0 && slot(rows.length, true)}
      </div>

      {drag && (
        <div
          className="pointer-events-none fixed z-50 rounded-md bg-slate-900/85 px-3 py-1.5 text-sm text-white shadow-lg"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.label}
        </div>
      )}

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

type DropTarget =
  | { type: "beside"; key: string; side: "before" | "after" }
  | { type: "row"; index: number }
  | { type: "card"; id: string; side: "before" | "after" };

/** A group or card being dragged, where the pointer is, and where it would land. */
interface Drag {
  kind: "group" | "card";
  key: string;
  /** Cards stay in their group: the group's key. */
  scope: string;
  label: string;
  x: number;
  y: number;
  target: DropTarget | null;
}

/** Where a drag would land with the pointer at (x, y): beside a group or card, or on a new line. */
function dropTarget(
  d: Pick<Drag, "kind" | "key" | "scope">,
  x: number,
  y: number,
): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const side = (box: HTMLElement) => {
    const r = box.getBoundingClientRect();
    return x < r.left + r.width / 2 ? ("before" as const) : ("after" as const);
  };
  if (d.kind === "card") {
    const card = el.closest<HTMLElement>("[data-card-id]");
    if (!card || card.dataset.cardScope !== d.scope || card.dataset.cardId === d.key) return null;
    return { type: "card", id: card.dataset.cardId!, side: side(card) };
  }
  const slot = el.closest<HTMLElement>("[data-row-slot]");
  if (slot) return { type: "row", index: Number(slot.dataset.rowSlot) };
  const group = el.closest<HTMLElement>("[data-group-key]");
  if (group) {
    if (group.dataset.groupKey === d.key) return null;
    return { type: "beside", key: group.dataset.groupKey!, side: side(group) };
  }
  // The empty end of a row: after its last group.
  const last = el.closest<HTMLElement>("[data-row-last]")?.dataset.rowLast;
  return last && last !== d.key ? { type: "beside", key: last, side: "after" } : null;
}

/** A blue bar in the gap before or after a group or card, where the dragged one would go. */
function DropBar({ side, gap }: { side: "before" | "after"; gap: string }) {
  const at = `calc(-${gap} - 2px)`;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-10 w-1 rounded bg-blue-500"
      style={side === "before" ? { left: at } : { right: at }}
    />
  );
}

/**
 * The space above, between or below the rows of groups. While a group is moved it is a place to
 * drop it on a line of its own; otherwise the ones between rows are just the gap.
 */
function RowSlot({
  index,
  showing,
  edge,
  targeted,
}: {
  index: number;
  showing: boolean;
  edge: boolean;
  targeted: boolean;
}) {
  if (!showing) return edge ? null : <div className="h-8" />;
  return (
    <div data-row-slot={index} className="flex h-12 items-center py-2">
      <div
        className={`flex h-full w-full items-center justify-center rounded-md border-2 border-dashed text-xs ${
          targeted
            ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            : "border-slate-300 text-slate-400 dark:border-slate-600"
        }`}
      >
        New line here
      </div>
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
          title="Drag to move this group, beside another or onto a line of its own"
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
