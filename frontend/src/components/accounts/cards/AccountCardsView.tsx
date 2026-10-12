import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../../../hooks/useApi";
import { useCategories } from "../../../hooks/useCategories";
import { formatMinor } from "../../../lib/money";
import { announceDataChanged } from "../../../lib/syncEvents";
import { timeAgo } from "../../../lib/time";
import type { Account, PlaidItem } from "../../../types/api";
import { ManualTransactionDialog } from "../../transactions/ManualTransactionDialog";
import { BankCsvImportDialog } from "../BankCsvImportDialog";
import { CollectionDialog, isCollection } from "../CollectionDialog";
import { CollectionShowcase } from "./CollectionShowcase";

/**
 * The experimental Accounts view: every account as a card you can pick up. Checking, savings and
 * credit accounts look like the debit and credit cards they are (tilt with the mouse, click to turn
 * over for the details and actions); linked accounts carry their bank's logo and a "Linked" mark,
 * accounts kept by hand a "Kept by hand" mark, side by side. Loans and investments are plainer
 * tiles, and collections get a showcase of their own (see CollectionShowcase).
 */
export function AccountCardsView({ items }: { items: PlaidItem[] }) {
  const accounts = useApi<Account[]>("/accounts?includeHidden=1");
  const { categories } = useCategories();
  const [adding, setAdding] = useState<Account | null>(null);
  const [importing, setImporting] = useState<Account | null>(null);
  const [managing, setManaging] = useState<Account | null>(null);
  const logos = useMemo(() => new Map(items.map((i) => [i.id, i.logo])), [items]);

  const all = accounts.data ?? [];
  const cards = all.filter(
    (a) => !isCollection(a) && (a.type === "depository" || a.type === "credit"),
  );
  const others = all.filter(
    (a) => !isCollection(a) && a.type !== "depository" && a.type !== "credit",
  );
  const collections = all.filter(isCollection);
  const manualBank = all.filter(
    (a) => a.isManual && !isCollection(a) && (a.type === "depository" || a.type === "credit"),
  );
  const changed = () => {
    setAdding(null);
    setImporting(null);
    accounts.reload();
    announceDataChanged();
  };

  if (accounts.error) return <p className="text-sm text-red-600">{accounts.error}</p>;
  if (!accounts.data) return <p className="text-sm text-slate-500">Loading your accounts...</p>;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Cards and bank accounts</h2>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((a) => (
            <PaymentCard
              key={a.id}
              account={a}
              logo={a.itemId === null ? null : (logos.get(a.itemId) ?? null)}
              onAdd={() => setAdding(a)}
              onImport={() => setImporting(a)}
            />
          ))}
        </div>
        {cards.length === 0 && (
          <p className="text-sm text-slate-500">No checking, savings or card accounts yet.</p>
        )}
      </section>

      {others.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Loans, investments and other</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {others.map((a) => (
              <OtherTile
                key={a.id}
                account={a}
                logo={a.itemId === null ? null : (logos.get(a.itemId) ?? null)}
              />
            ))}
          </div>
        </section>
      )}

      {collections.length > 0 && (
        <section className="space-y-6">
          <h2 className="text-lg font-semibold">Collections</h2>
          {collections.map((a) => (
            <CollectionShowcase key={a.id} account={a} onManage={() => setManaging(a)} />
          ))}
        </section>
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

const money = (a: Account, minor: number | null) => formatMinor(minor, a.currency || "USD");

/** A colour a little darker than `hex` (#rrggbb), for the card's gradient. */
function darker(hex: string, amount = 0.35): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#1e293b";
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

const DEFAULT_COLOR: Record<string, string> = {
  credit: "#4338ca",
  depository: "#0f766e",
};

/** Whose card it is, for the corner of the card: the bank's logo, or its initials. */
function Brand({ account, logo }: { account: Account; logo: string | null }) {
  const name = account.institutionName ?? (account.isManual ? "Kept by hand" : "");
  if (logo) {
    return (
      <img src={logo} alt="" className="h-7 w-7 rounded-full bg-white/90 object-contain p-0.5" />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-[0.65rem] font-semibold">
      {initials || "✎"}
    </span>
  );
}

/** Linked through Plaid, or kept by hand: the same kind of card, told apart by this mark. */
function SourceMark({ account }: { account: Account }) {
  return account.isManual ? (
    <span className="rounded-full bg-white/15 px-2 py-0.5 text-[0.65rem] font-medium tracking-wide uppercase">
      Kept by hand
    </span>
  ) : (
    <span
      className="flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[0.65rem] font-medium tracking-wide uppercase"
      title={
        account.connectionStatus === "active"
          ? "Linked and syncing"
          : "Linked; the connection needs attention"
      }
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${account.connectionStatus === "active" ? "bg-emerald-300" : "bg-amber-300"}`}
      />
      Linked
    </span>
  );
}

function PaymentCard({
  account: a,
  logo,
  onAdd,
  onImport,
}: {
  account: Account;
  logo: string | null;
  onAdd: () => void;
  onImport: () => void;
}) {
  const navigate = useNavigate();
  const [flipped, setFlipped] = useState(false);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const credit = a.type === "credit";
  const color = a.color ?? DEFAULT_COLOR[a.type] ?? "#334155";
  const used =
    credit && a.creditLimitMinor && a.creditLimitMinor > 0
      ? Math.min(1, Math.max(0, (a.currentBalanceMinor ?? 0) / a.creditLimitMinor))
      : null;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setTilt({ x: (e.clientX - r.left) / r.width - 0.5, y: (e.clientY - r.top) / r.height - 0.5 });
  };
  const face: CSSProperties = {
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
    background: `linear-gradient(135deg, ${color} 0%, ${darker(color)} 100%)`,
  };

  return (
    <div
      ref={box}
      className={`group [perspective:1000px] ${a.hidden ? "opacity-50" : ""}`}
      onMouseMove={onMove}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
    >
      <div
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={`${a.name}: ${flipped ? "showing details" : "turn over for details"}`}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((f) => !f);
          }
        }}
        className="relative aspect-[1.586] w-full cursor-pointer rounded-2xl shadow-lg transition-[transform,box-shadow] duration-300 ease-out outline-none group-hover:shadow-2xl focus-visible:ring-4 focus-visible:ring-blue-400"
        style={{
          transformStyle: "preserve-3d",
          transform: `rotateY(${(flipped ? 180 : 0) + tilt.x * 14}deg) rotateX(${-tilt.y * 10}deg)`,
        }}
      >
        {/* Front: what is on a real card. */}
        <div
          style={face}
          className="absolute inset-0 flex flex-col justify-between overflow-hidden rounded-2xl p-4 text-white"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-60 transition-opacity group-hover:opacity-90"
            style={{
              background: `radial-gradient(circle at ${50 + tilt.x * 80}% ${50 + tilt.y * 80}%, rgba(255,255,255,0.28), transparent 55%)`,
            }}
          />
          <div className="relative flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Brand account={a} logo={logo} />
              <span className="truncate text-sm font-semibold">
                {a.institutionName ?? "Your account"}
              </span>
            </div>
            <SourceMark account={a} />
          </div>
          <div className="relative flex items-center gap-3">
            {/* The chip. */}
            <span
              aria-hidden="true"
              className="h-7 w-10 rounded-md border border-amber-200/60 bg-gradient-to-br from-amber-200 to-amber-500 shadow-inner"
            />
            <span className="font-mono text-lg tracking-[0.2em] opacity-90">
              •••• {a.mask ?? "····"}
            </span>
          </div>
          <div className="relative flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs opacity-80">{a.name}</div>
              <div className="text-xl font-semibold tabular-nums">
                {money(a, a.currentBalanceMinor)}
              </div>
            </div>
            <span className="text-right text-sm font-black tracking-widest italic opacity-90">
              {credit ? "CREDIT" : a.subtype?.toLowerCase() === "savings" ? "SAVINGS" : "DEBIT"}
            </span>
          </div>
          {a.hidden && (
            <span className="absolute right-3 bottom-12 rounded bg-black/40 px-1.5 text-[0.65rem]">
              Hidden
            </span>
          )}
        </div>

        {/* Back: the details and what you can do. */}
        <div
          style={{ ...face, transform: "rotateY(180deg)" }}
          className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl text-white"
        >
          <div aria-hidden="true" className="mt-4 h-8 w-full bg-black/70" />
          <dl className="grid flex-1 grid-cols-2 gap-x-3 gap-y-1 px-4 pt-3 text-xs">
            <dt className="opacity-70">Balance</dt>
            <dd className="text-right font-medium tabular-nums">
              {money(a, a.currentBalanceMinor)}
            </dd>
            {a.availableBalanceMinor !== null && (
              <>
                <dt className="opacity-70">Available</dt>
                <dd className="text-right tabular-nums">{money(a, a.availableBalanceMinor)}</dd>
              </>
            )}
            {credit && a.creditLimitMinor !== null && (
              <>
                <dt className="opacity-70">Limit</dt>
                <dd className="text-right tabular-nums">{money(a, a.creditLimitMinor)}</dd>
              </>
            )}
            <dt className="opacity-70">Kind</dt>
            <dd className="truncate text-right">{a.subtype ?? a.type}</dd>
            <dt className="opacity-70">Updated</dt>
            <dd className="truncate text-right">
              {a.lastBalanceUpdateAt ? timeAgo(a.lastBalanceUpdateAt) : "never"}
            </dd>
          </dl>
          {used !== null && (
            <div className="px-4 pb-1" title={`${Math.round(used * 100)}% of the limit used`}>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
                <div
                  className={`h-full rounded-full ${used > 0.5 ? "bg-amber-300" : "bg-emerald-300"}`}
                  style={{ width: `${used * 100}%` }}
                />
              </div>
              <div className="mt-0.5 text-[0.65rem] opacity-70">
                {Math.round(used * 100)}% of the limit used
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 px-4 pb-3" onClick={(e) => e.stopPropagation()}>
            <CardButton onClick={() => navigate(`/transactions?account=${a.id}`)}>
              Transactions
            </CardButton>
            {a.isManual && (
              <>
                <CardButton onClick={onAdd}>Add</CardButton>
                <CardButton onClick={onImport}>Import CSV</CardButton>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CardButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(e) => e.stopPropagation()}
      className="rounded-full bg-white/20 px-2.5 py-1 text-xs font-medium hover:bg-white/35 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

/** A loan, an investment account or anything else: a plainer tile that lifts on hover. */
function OtherTile({ account: a, logo }: { account: Account; logo: string | null }) {
  const color = a.color ?? "#475569";
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-1 hover:shadow-lg dark:border-slate-700 dark:bg-slate-800 ${a.hidden ? "opacity-50" : ""}`}
      style={{ borderLeft: `6px solid ${color}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {logo && <img src={logo} alt="" className="h-6 w-6 rounded-full object-contain" />}
          <span className="truncate font-medium">{a.name}</span>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {a.isManual ? "Kept by hand" : "Linked"}
        </span>
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">
        {money(a, a.currentBalanceMinor)}
      </div>
      <div className="text-xs text-slate-500">
        {a.institutionName ?? ""} {a.subtype ?? a.type}
      </div>
    </div>
  );
}
