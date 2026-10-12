import { useMemo, useState } from "react";
import { useApi } from "../../../hooks/useApi";
import { formatMinor } from "../../../lib/money";
import type { Account } from "../../../types/api";
import { Modal } from "../../common/Modal";
import { Select } from "../../common/Select";

interface Item {
  id: number;
  name: string;
  variant: string;
  setCode: string;
  number: string;
  quantity: number;
  unitValueMinor: number | null;
  totalValueMinor: number;
  condition: string | null;
  notes: string | null;
  tcgplayerId: string | null;
  marketPriceMinor: number | null;
  priceUpdatedAt: string | null;
}

interface Collection {
  accountId: number;
  name: string;
  type: "pokemon" | "other";
  items: Item[];
  totalValueMinor: number;
}

type Sort = "value" | "name";

const money = (minor: number | null) => formatMinor(minor, "USD");

/** TCGplayer's public picture of a card, when the item is matched to a TCGplayer product. */
const cardImage = (id: string) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`;
const cardImageLarge = (id: string) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_400w.jpg`;

/**
 * A collection shown for what it is: Pokémon cards as a binder of cards (their pictures when
 * matched to TCGplayer, lifting and tilting under the mouse; click one to look closer), anything
 * else as items on display shelves, the more valuable standing taller. "Manage" opens the full
 * collection editor.
 */
export function CollectionShowcase({
  account,
  onManage,
}: {
  account: Account;
  onManage: () => void;
}) {
  const loaded = useApi<Collection>(`/accounts/${account.id}/collection`);
  const [sort, setSort] = useState<Sort>("value");
  const [open, setOpen] = useState<Item | null>(null);
  const items = useMemo(() => {
    const list = [...(loaded.data?.items ?? [])];
    return sort === "value"
      ? list.sort((a, b) => b.totalValueMinor - a.totalValueMinor || a.name.localeCompare(b.name))
      : list.sort((a, b) => a.name.localeCompare(b.name));
  }, [loaded.data, sort]);
  const c = loaded.data;
  const pieces = items.reduce((n, i) => n + i.quantity, 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{account.name}</div>
          <div className="text-xs text-slate-500">
            {c
              ? `${pieces} item${pieces === 1 ? "" : "s"} · worth ${money(c.totalValueMinor)}`
              : "Loading..."}
            {c?.type === "pokemon" ? " · Pokémon cards" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Sort the collection"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800"
          >
            <option value="value">Most valuable first</option>
            <option value="name">By name</option>
          </Select>
          <button
            type="button"
            onClick={onManage}
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
          >
            Manage
          </button>
        </div>
      </div>
      {loaded.error && <p className="text-sm text-red-600">{loaded.error}</p>}
      {c && items.length === 0 && (
        <p className="text-sm text-slate-500">Nothing in it yet. Use Manage to add items.</p>
      )}
      {c?.type === "pokemon" ? (
        <Binder items={items} onOpen={setOpen} />
      ) : (
        <Shelves items={items} total={c?.totalValueMinor ?? 0} onOpen={setOpen} />
      )}
      {open && (
        <ItemDetails item={open} pokemon={c?.type === "pokemon"} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** Pokémon cards in binder pockets. */
function Binder({ items, onOpen }: { items: Item[]; onOpen: (item: Item) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3 rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 p-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
      {items.map((item) => (
        <PokemonCard key={item.id} item={item} onOpen={() => onOpen(item)} />
      ))}
    </div>
  );
}

function PokemonCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [broken, setBroken] = useState(false);
  const picture = item.tcgplayerId && !broken ? cardImage(item.tcgplayerId) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${item.name} · ${money(item.totalValueMinor)}`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTilt({
          x: (e.clientX - r.left) / r.width - 0.5,
          y: (e.clientY - r.top) / r.height - 0.5,
        });
      }}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
      className="group relative aspect-[63/88] w-full [perspective:600px] focus-visible:outline-none"
    >
      <span
        className="absolute inset-0 overflow-hidden rounded-lg bg-slate-700 shadow-md ring-1 ring-black/40 transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:shadow-xl group-focus-visible:ring-4 group-focus-visible:ring-amber-300"
        style={{ transform: `rotateY(${tilt.x * 18}deg) rotateX(${-tilt.y * 18}deg)` }}
      >
        {picture ? (
          <img
            src={picture}
            alt={item.name}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-amber-300 via-yellow-200 to-amber-500 p-1.5 text-left text-slate-900">
            <span className="line-clamp-3 text-[0.65rem] leading-tight font-bold">{item.name}</span>
            <span className="text-[0.6rem] opacity-70">
              {item.setCode} {item.number}
            </span>
          </span>
        )}
        {/* A holo shine that follows the mouse. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 mix-blend-overlay transition-opacity group-hover:opacity-100"
          style={{
            background: `linear-gradient(${105 + tilt.x * 60}deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)`,
          }}
        />
        {item.quantity > 1 && (
          <span className="absolute top-1 right-1 rounded-full bg-black/70 px-1.5 text-[0.6rem] font-semibold text-white">
            ×{item.quantity}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-center text-[0.6rem] font-medium text-white tabular-nums">
          {money(item.totalValueMinor)}
        </span>
      </span>
    </button>
  );
}

/** Anything else on shelves: each item a box, taller the more of the collection's value it holds. */
function Shelves({
  items,
  total,
  onOpen,
}: {
  items: Item[];
  total: number;
  onOpen: (item: Item) => void;
}) {
  const perShelf = 6;
  const shelves: Item[][] = [];
  for (let i = 0; i < items.length; i += perShelf) shelves.push(items.slice(i, i + perShelf));
  const top = Math.max(1, ...items.map((i) => i.totalValueMinor));
  return (
    <div className="space-y-4">
      {shelves.map((shelf, s) => (
        <div
          key={s}
          className="flex items-end gap-3 border-b-8 border-amber-800/70 px-2 pb-0 dark:border-amber-900"
        >
          {shelf.map((item, i) => {
            const share = total > 0 ? item.totalValueMinor / total : 0;
            const height = 64 + Math.round((item.totalValueMinor / top) * 72);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item)}
                title={`${item.name} · ${money(item.totalValueMinor)} (${Math.round(share * 100)}% of the collection)`}
                style={{ height, background: `hsl(${((s * perShelf + i) * 47) % 360} 55% 45%)` }}
                className="flex min-w-0 flex-1 flex-col justify-between rounded-t-lg p-2 text-left text-white shadow-md transition hover:-translate-y-2 hover:shadow-xl focus-visible:ring-4 focus-visible:ring-blue-400 focus-visible:outline-none"
              >
                <span className="line-clamp-2 text-xs leading-tight font-semibold">
                  {item.name}
                </span>
                <span className="text-xs tabular-nums opacity-90">
                  {money(item.totalValueMinor)}
                  {item.quantity > 1 ? ` · ×${item.quantity}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ItemDetails({
  item,
  pokemon,
  onClose,
}: {
  item: Item;
  pokemon: boolean;
  onClose: () => void;
}) {
  return (
    <Modal title={item.name} onClose={onClose} dismissible>
      <div className="flex flex-wrap gap-4 text-sm">
        {pokemon && item.tcgplayerId && (
          <img
            src={cardImageLarge(item.tcgplayerId)}
            alt={item.name}
            className="w-48 rounded-xl shadow-lg"
          />
        )}
        <dl className="grid min-w-48 flex-1 grid-cols-2 gap-x-3 gap-y-1 self-start">
          {item.variant && (
            <>
              <dt className="text-slate-500">Variant</dt>
              <dd>{item.variant}</dd>
            </>
          )}
          {(item.setCode || item.number) && (
            <>
              <dt className="text-slate-500">Set</dt>
              <dd>
                {item.setCode} {item.number}
              </dd>
            </>
          )}
          {item.condition && (
            <>
              <dt className="text-slate-500">Condition</dt>
              <dd>{item.condition}</dd>
            </>
          )}
          <dt className="text-slate-500">Quantity</dt>
          <dd>{item.quantity}</dd>
          <dt className="text-slate-500">Each</dt>
          <dd className="tabular-nums">{money(item.unitValueMinor)}</dd>
          <dt className="text-slate-500">Together</dt>
          <dd className="font-medium tabular-nums">{money(item.totalValueMinor)}</dd>
          {item.marketPriceMinor !== null && (
            <>
              <dt className="text-slate-500">Market price</dt>
              <dd className="tabular-nums">{money(item.marketPriceMinor)}</dd>
            </>
          )}
          {item.notes && (
            <>
              <dt className="text-slate-500">Notes</dt>
              <dd>{item.notes}</dd>
            </>
          )}
        </dl>
      </div>
    </Modal>
  );
}
