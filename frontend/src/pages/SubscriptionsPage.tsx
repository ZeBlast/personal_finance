import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { CategorySelect } from "../components/common/CategorySelect";
import { RecurringSection } from "../components/insights/RecurringSection";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { Select } from "../components/common/Select";
import { buttonClass, inputClass, primaryClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { CADENCE_LABEL } from "../lib/insights";
import { formatMinor, parseMoneyToMinor } from "../lib/money";
import { announceDataChanged } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import type { Account } from "../types/api";
import type { Cadence } from "../types/insights";
import type {
  PaymentHistory,
  RecurringChange,
  RenewalItem,
  Subscription,
  SubscriptionBilling,
  SubscriptionFrequency,
  SubscriptionReview,
  SubscriptionStatus,
  TrackedSubscription,
  TrackedSubscriptionList,
} from "../types/planning";

const money = (n: number) => formatMinor(n, "USD");
const todayDay = () => new Date().toISOString().slice(0, 10);

/**
 * Everything you pay for again and again: subscriptions you keep track of (added here, with the
 * details of the account such as the email used), and the recurring charges found in your history.
 */
export function SubscriptionsPage() {
  const tracked = useApi<TrackedSubscriptionList>("/tracked-subscriptions");
  const review = useApi<SubscriptionReview>("/subscriptions");
  const [editing, setEditing] = useState<Draft | null>(null);

  const reload = () => {
    tracked.reload();
    review.reload();
    announceDataChanged();
  };
  const trackedKeys = new Set(
    (tracked.data?.subscriptions ?? []).map((s) => s.recurringKey).filter(Boolean),
  );

  return (
    <section className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Subscriptions</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What you pay for again and again, when each charges next or ends, and the details of
            each account. Upcoming charges of ones you add show on the calendar.
          </p>
        </div>
        <button type="button" className={primaryClass} onClick={() => setEditing(emptyDraft())}>
          Add a subscription
        </button>
      </div>

      <RenewalInbox
        onOpen={(id) => {
          const s = tracked.data?.subscriptions.find((x) => x.id === id);
          if (s) setEditing(draftOf(s));
        }}
      />
      <TrackedSection state={tracked} onEdit={(s) => setEditing(draftOf(s))} onChanged={reload} />
      <FoundSection
        state={review}
        trackedKeys={trackedKeys}
        onTrack={(s) => setEditing(draftFromSeries(s))}
      />
      {/* Every regular charge and deposit found, bills and pay included (moved from Insights). */}
      <RecurringSection />

      {editing && (
        <SubscriptionDialog
          draft={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      )}
    </section>
  );
}

// ---- Your subscriptions --------------------------------------------------------------------------

/** How it is billed, in words: "$15.49 every month", "$40 a month for 12 months". */
export function billingText(s: {
  amountMinor: number;
  billing: SubscriptionBilling;
  frequency: SubscriptionFrequency | null;
  repeatEvery: number;
  termMonths: number | null;
}): string {
  if (s.amountMinor === 0) {
    return s.billing === "recurring" ? "Free" : `Free, for ${s.termMonths} months`;
  }
  const amount = money(s.amountMinor);
  if (s.billing === "installments") return `${amount} a month for ${s.termMonths} months`;
  if (s.billing === "prepaid") return `${amount} once, for ${s.termMonths} months`;
  const unit = s.frequency === "weekly" ? "week" : s.frequency === "yearly" ? "year" : "month";
  return s.repeatEvery > 1
    ? `${amount} every ${s.repeatEvery} ${unit}s`
    : `${amount} every ${unit}`;
}

function TrackedSection({
  state,
  onEdit,
  onChanged,
}: {
  state: ReturnType<typeof useApi<TrackedSubscriptionList>>;
  onEdit: (s: TrackedSubscription) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TrackedSubscription | null>(null);
  const [payments, setPayments] = useState<TrackedSubscription | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }
  if (!state.data) return <p className="text-sm text-slate-500">Loading...</p>;
  const { subscriptions, totals } = state.data;
  const shown = subscriptions.filter((s) => showEnded || !s.ended);

  async function act(path: string, init: RequestInit): Promise<void> {
    try {
      await api(path, init);
      setError(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <section aria-labelledby="tracked-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tracked-heading" className="text-lg font-medium">
          Your subscriptions
        </h2>
        <span className="text-sm text-slate-500">
          {totals.active} active · {money(totals.monthlyMinor)} a month ·{" "}
          {money(totals.yearlyMinor)} a year
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {subscriptions.some((s) => s.ended) && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          Also show cancelled and ended ones
        </label>
      )}
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-600">
          None yet. Add one with “Add a subscription”, or track one found in your history below.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {shown.map((s) => (
            <li
              key={s.id}
              className={`space-y-2 rounded-lg border p-3 text-sm ${
                s.ended
                  ? "border-slate-200 opacity-70 dark:border-slate-700"
                  : "border-slate-200 dark:border-slate-700"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="text-slate-500">{billingText(s)}</div>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums">{money(s.monthlyMinor)}</span>
                  <span className="text-xs text-slate-500">a month</span>
                </span>
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300">
                {s.status === "cancelled"
                  ? `Cancelled ${s.cancelledOn ? formatDay(s.cancelledOn) : ""}`
                  : s.ended
                    ? `Ended ${s.endDate ? formatDay(s.endDate) : ""}`
                    : [
                        s.nextCharge && `Next charge ${formatDay(s.nextCharge)}`,
                        s.chargesLeft !== null && `${s.chargesLeft} charges left`,
                        s.endDate && `ends ${formatDay(s.endDate)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                {s.onCalendar ? " · on the calendar" : ""}
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {s.accountName && <Detail label="Paid from" value={s.accountName} />}
                {s.categoryName && <Detail label="Category" value={s.categoryName} />}
                {s.email && <Detail label="Email" value={s.email} />}
                {s.username && <Detail label="Username" value={s.username} />}
                {s.website && <Detail label="Website" value={s.website} />}
                {s.notes && <Detail label="Notes" value={s.notes} />}
              </dl>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => onEdit(s)}>
                  Edit
                </button>
                <button type="button" className={buttonClass} onClick={() => setPayments(s)}>
                  Payments
                </button>
                {s.status === "active" ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void act(`/tracked-subscriptions/${s.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({ status: "cancelled", on: todayDay() }),
                      })
                    }
                  >
                    Mark cancelled
                  </button>
                ) : (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void act(`/tracked-subscriptions/${s.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({ status: "active" }),
                      })
                    }
                  >
                    Active again
                  </button>
                )}
                <button
                  type="button"
                  className={`${buttonClass} text-red-700 dark:text-red-400`}
                  onClick={() => setRemoving(s)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {payments && <PaymentsDialog subscription={payments} onClose={() => setPayments(null)} />}
      {removing && (
        <ConfirmDialog
          title={`Stop tracking ${removing.name}?`}
          message="Its details are removed, and its upcoming charges leave the calendar. Your transactions are not changed."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            void act(`/tracked-subscriptions/${id}`, { method: "DELETE" });
          }}
        />
      )}
    </section>
  );
}

// ---- Coming up -----------------------------------------------------------------------------------

/** What an inbox item says next to its title: when, and how much. Pure. */
export function renewalWhen(item: RenewalItem, today: string): string {
  const days = Math.round((Date.parse(item.date) - Date.parse(today)) / 86_400_000);
  const when =
    item.kind === "price"
      ? `charged ${formatDay(item.date)}`
      : days === 0
        ? "today"
        : days === 1
          ? "tomorrow"
          : `in ${days} days, ${formatDay(item.date)}`;
  if (item.kind === "price" && item.changeMinor) {
    return `${when} · now ${money(item.amountMinor ?? 0)}, up ${money(item.changeMinor)}`;
  }
  return item.amountMinor ? `${when} · ${money(item.amountMinor)}` : when;
}

/** Trials ending, yearly renewals, plans ending and price rises: deal with each, then dismiss it. */
function RenewalInbox({ onOpen }: { onOpen: (subscriptionId: number) => void }) {
  const inbox = useApi<RenewalItem[]>("/renewals");
  const [error, setError] = useState<string | null>(null);
  if (!inbox.data || inbox.data.length === 0) return null;

  async function dismiss(key: string): Promise<void> {
    try {
      await api("/renewals/dismiss", { method: "POST", body: JSON.stringify({ key }) });
      inbox.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not dismiss that."));
    }
  }

  return (
    <section
      aria-labelledby="renewals-heading"
      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
    >
      <h2 id="renewals-heading" className="font-medium">
        Coming up
      </h2>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <ul className="space-y-2 text-sm">
        {inbox.data.map((item) => (
          <li key={item.key} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">
                {item.title}{" "}
                <span className="font-normal text-slate-600 dark:text-slate-300">
                  {renewalWhen(item, todayDay())}
                </span>
              </div>
              <div className="text-xs text-slate-500">{item.detail}</div>
            </div>
            <div className="flex gap-2">
              {item.subscriptionId !== null && (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => onOpen(item.subscriptionId!)}
                >
                  Open
                </button>
              )}
              <button type="button" className={buttonClass} onClick={() => void dismiss(item.key)}>
                Done
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What was paid to a subscription over time; a payment that is not its own can be left out. */
function PaymentsDialog({
  subscription,
  onClose,
}: {
  subscription: TrackedSubscription;
  onClose: () => void;
}) {
  const path = `/tracked-subscriptions/${subscription.id}/payments`;
  const history = useApi<PaymentHistory>(path);
  const [error, setError] = useState<string | null>(null);

  async function toggle(transactionId: number, excluded: boolean): Promise<void> {
    try {
      await api(`${path}/${transactionId}`, {
        method: "PUT",
        body: JSON.stringify({ excluded }),
      });
      history.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  const h = history.data;
  return (
    <Modal title={`${subscription.name} payments`} onClose={onClose} dismissible>
      <div className="space-y-3 text-sm">
        {h && (
          <p className="text-slate-600 dark:text-slate-300">
            Transactions whose merchant has “{h.match}”
            {h.matchSource === "found" ? " (found in your history)" : ""}. Change what it looks for
            with Edit. {money(h.totalMinor)} paid over the last three years.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {h?.payments.length === 0 && <p className="text-slate-500">No payments found.</p>}
        <ol className="max-h-96 space-y-1 overflow-y-auto">
          {h?.payments.map((p) => (
            <li
              key={p.id}
              className={`flex items-center justify-between gap-2 border-l-2 pl-2 ${p.excluded ? "border-slate-200 opacity-60 dark:border-slate-700" : "border-blue-500"}`}
            >
              <div className="min-w-0">
                <div className={p.excluded ? "line-through" : ""}>
                  {formatDay(p.date)} · {p.merchant}
                </div>
                <div className="text-xs text-slate-500">{p.accountName}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-right tabular-nums">
                  {money(p.amountMinor)}
                  {p.changeMinor !== null && (
                    <span
                      className={`block text-xs ${p.changeMinor > 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
                    >
                      {p.changeMinor > 0 ? "+" : "−"}
                      {money(Math.abs(p.changeMinor))}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void toggle(p.id, !p.excluded)}
                >
                  {p.excluded ? "Count it" : "Not this"}
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{value}</dd>
    </>
  );
}

// ---- The add / edit dialog -----------------------------------------------------------------------

interface Draft {
  id: number | null;
  name: string;
  amount: string;
  billing: SubscriptionBilling;
  frequency: SubscriptionFrequency;
  repeatEvery: string;
  startDate: string;
  termMonths: string;
  accountId: string;
  categoryId: string;
  email: string;
  username: string;
  website: string;
  notes: string;
  recurringKey: string | null;
  trialEndsOn: string;
  paymentMatch: string;
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    amount: "",
    billing: "recurring",
    frequency: "monthly",
    repeatEvery: "1",
    startDate: todayDay(),
    termMonths: "12",
    accountId: "",
    categoryId: "",
    email: "",
    username: "",
    website: "",
    notes: "",
    recurringKey: null,
    trialEndsOn: "",
    paymentMatch: "",
  };
}

function draftOf(s: TrackedSubscription): Draft {
  return {
    id: s.id,
    name: s.name,
    amount: (s.amountMinor / 100).toFixed(2),
    billing: s.billing,
    frequency: s.frequency ?? "monthly",
    repeatEvery: String(s.repeatEvery),
    startDate: s.startDate,
    termMonths: String(s.termMonths ?? 12),
    accountId: s.accountId === null ? "" : String(s.accountId),
    categoryId: s.categoryId === null ? "" : String(s.categoryId),
    email: s.email ?? "",
    username: s.username ?? "",
    website: s.website ?? "",
    notes: s.notes ?? "",
    recurringKey: s.recurringKey,
    trialEndsOn: s.trialEndsOn ?? "",
    paymentMatch: s.paymentMatch ?? "",
  };
}

/** A recurring charge found in the history, as a subscription to track. */
export function draftFromSeries(s: Subscription): Draft {
  const cadence = s.cadence as Cadence;
  const [frequency, every]: [SubscriptionFrequency, number] =
    cadence === "weekly"
      ? ["weekly", 1]
      : cadence === "biweekly"
        ? ["weekly", 2]
        : cadence === "quarterly"
          ? ["monthly", 3]
          : cadence === "yearly"
            ? ["yearly", 1]
            : ["monthly", 1];
  return {
    ...emptyDraft(),
    name: s.merchant,
    amount: (s.typicalAmountMinor / 100).toFixed(2),
    frequency,
    repeatEvery: String(every),
    startDate: s.firstDate,
    recurringKey: s.key,
  };
}

/** The draft as a request, or what is wrong. Pure, so it can be tested. */
export function buildSubscription(
  d: Draft,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!d.name.trim()) return { ok: false, message: "Enter the subscription's name." };
  // Blank or 0 is a free subscription, kept only to keep track of it.
  const amount = d.amount.trim() === "" ? 0 : parseMoneyToMinor(d.amount, "USD");
  if (amount === null || amount < 0) {
    return { ok: false, message: "Enter what each charge costs, such as 15.49 (0 if free)." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.startDate)) {
    return { ok: false, message: "Choose the day it starts." };
  }
  const recurring = d.billing === "recurring";
  const every = Number(d.repeatEvery);
  const term = Number(d.termMonths);
  if (recurring && (!Number.isInteger(every) || every < 1 || every > 36)) {
    return { ok: false, message: "Repeat every 1 to 36 periods." };
  }
  if (!recurring && (!Number.isInteger(term) || term < 1 || term > 120)) {
    return { ok: false, message: "Enter how many months it lasts (1 to 120)." };
  }
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  return {
    ok: true,
    body: {
      name: d.name.trim(),
      amountMinor: amount,
      billing: d.billing,
      frequency: recurring ? d.frequency : null,
      repeatEvery: recurring ? every : 1,
      startDate: d.startDate,
      termMonths: recurring ? null : term,
      accountId: d.accountId ? Number(d.accountId) : null,
      categoryId: d.categoryId ? Number(d.categoryId) : null,
      email: opt(d.email),
      username: opt(d.username),
      website: opt(d.website),
      notes: opt(d.notes),
      recurringKey: d.recurringKey,
      trialEndsOn: opt(d.trialEndsOn),
      paymentMatch: opt(d.paymentMatch),
    },
  };
}

const BILLING_CHOICES: Array<{ value: SubscriptionBilling; label: string; help: string }> = [
  { value: "recurring", label: "Renews", help: "Charged again and again until you cancel." },
  {
    value: "installments",
    label: "Monthly for a set time",
    help: "Charged every month for a number of months, then it ends.",
  },
  {
    value: "prepaid",
    label: "Paid once for a set time",
    help: "One charge that covers a number of months from the start day.",
  },
];

function SubscriptionDialog({
  draft,
  onClose,
}: {
  draft: Draft;
  onClose: (saved: boolean) => void;
}) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = useApi<Account[]>("/accounts");
  const { categories } = useCategories();
  const options = categoryOptions((categories ?? []).filter((c) => c.active));
  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const built = buildSubscription(d);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(d.id === null ? "/tracked-subscriptions" : `/tracked-subscriptions/${d.id}`, {
        method: d.id === null ? "POST" : "PUT",
        body: JSON.stringify(built.body),
      });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the subscription."));
      setBusy(false);
    }
  }

  const label = "block text-sm font-medium";
  return (
    <Modal
      title={
        d.id === null
          ? d.recurringKey
            ? `Track ${d.name}`
            : "Add a subscription"
          : `Edit ${d.name}`
      }
      onClose={() => onClose(false)}
      wide
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Name
            <input
              value={d.name}
              maxLength={120}
              autoFocus
              onChange={(e) => set({ name: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className={label}>
            Cost of each charge
            <input
              value={d.amount}
              inputMode="decimal"
              placeholder="0.00 if free"
              title="Leave it at 0 for a free subscription you only want to keep track of."
              onChange={(e) => set({ amount: e.target.value })}
              className={inputClass}
            />
          </label>
        </div>

        <fieldset className="space-y-1">
          <legend className={label}>How it is billed</legend>
          {BILLING_CHOICES.map((c) => (
            <label key={c.value} className="flex items-start gap-2">
              <input
                type="radio"
                name="billing"
                className="mt-1"
                checked={d.billing === c.value}
                onChange={() => set({ billing: c.value })}
              />
              <span>
                {c.label}
                <span className="block text-xs text-slate-500">{c.help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className={label}>
            {d.billing === "recurring" ? "First charge" : "Starts on"}
            <input
              type="date"
              value={d.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
              className={inputClass}
            />
          </label>
          {d.billing === "recurring" ? (
            <>
              <label className={label}>
                Renews every
                <input
                  value={d.repeatEvery}
                  inputMode="numeric"
                  onChange={(e) => set({ repeatEvery: e.target.value })}
                  className={inputClass}
                />
              </label>
              <label className={label}>
                Period
                <Select
                  value={d.frequency}
                  onChange={(e) => set({ frequency: e.target.value as SubscriptionFrequency })}
                  className={inputClass}
                >
                  <option value="weekly">Week(s)</option>
                  <option value="monthly">Month(s)</option>
                  <option value="yearly">Year(s)</option>
                </Select>
              </label>
            </>
          ) : (
            <label className={label}>
              For how many months
              <input
                value={d.termMonths}
                inputMode="numeric"
                onChange={(e) => set({ termMonths: e.target.value })}
                className={inputClass}
              />
            </label>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Paid from
            <Select
              value={d.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
              className={inputClass}
            >
              <option value="">Not set</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </label>
          <label className={label}>
            Category
            <CategorySelect
              shown={options.find((o) => String(o.id) === d.categoryId)?.name ?? "No category"}
              value={d.categoryId}
              onChange={(e) => set({ categoryId: e.target.value })}
              className={inputClass}
            >
              <option value="">No category</option>
              {options.map((o) => (
                <option key={o.id} value={o.id} data-depth={o.depth}>
                  {o.label}
                </option>
              ))}
            </CategorySelect>
          </label>
        </div>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <legend className="px-1 text-sm font-medium">The account with the service</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Email used
              <input
                type="email"
                value={d.email}
                maxLength={200}
                onChange={(e) => set({ email: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={label}>
              Username
              <input
                value={d.username}
                maxLength={200}
                onChange={(e) => set({ username: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <label className={label}>
            Website
            <input
              value={d.website}
              maxLength={300}
              placeholder="netflix.com/account"
              onChange={(e) => set({ website: e.target.value })}
              className={inputClass}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Free trial ends (optional)
              <input
                type="date"
                value={d.trialEndsOn}
                onChange={(e) => set({ trialEndsOn: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={label}>
              Its payments say (optional)
              <input
                value={d.paymentMatch}
                maxLength={120}
                placeholder={d.name || "NETFLIX.COM"}
                onChange={(e) => set({ paymentMatch: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <p className="-mt-2 text-xs text-slate-500">
            Payments are found by this text in the merchant name; empty uses the name above.
          </p>
          <label className={label}>
            Notes
            <textarea
              value={d.notes}
              rows={2}
              maxLength={2000}
              placeholder="Plan, who shares it, how to cancel..."
              onChange={(e) => set({ notes: e.target.value })}
              className={inputClass}
            />
          </label>
          <p className="text-xs text-slate-500">
            Kept in the app&apos;s encrypted database. Don&apos;t store passwords here.
          </p>
        </fieldset>

        {d.recurringKey && (
          <p className="text-xs text-slate-500">
            Found in your history: its charges already count in the forecast, so they are not added
            to the calendar again.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => onClose(false)}
          >
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Found in your history -----------------------------------------------------------------------

const DECISIONS: Array<{ value: SubscriptionStatus | ""; label: string }> = [
  { value: "", label: "Not decided" },
  { value: "keep", label: "Keep" },
  { value: "cancel", label: "Cancel it" },
  { value: "cancelled", label: "Cancelled" },
];

function FoundSection({
  state,
  trackedKeys,
  onTrack,
}: {
  state: ReturnType<typeof useApi<SubscriptionReview>>;
  trackedKeys: Set<string | null>;
  onTrack: (s: Subscription) => void;
}) {
  const [showLapsed, setShowLapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }
  if (!state.data) return <p className="text-sm text-slate-500">Loading...</p>;
  const data = state.data;
  const cash = (n: number) => formatMinor(n, data.currency);
  const shown = data.subscriptions.filter((s) => showLapsed || s.status === "active");

  async function decide(s: Subscription, status: SubscriptionStatus | ""): Promise<void> {
    try {
      await api(`/subscriptions/${encodeURIComponent(s.key)}`, {
        method: "PUT",
        body: JSON.stringify({
          merchant: s.merchant,
          status: status === "" ? null : status,
          note: s.review?.note ?? null,
        }),
      });
      setError(null);
      state.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <section aria-labelledby="found-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="found-heading" className="text-lg font-medium">
          Found in your history
        </h2>
        <span className="text-sm text-slate-500">
          {cash(data.totals.monthlyMinor)} a month · {cash(data.totals.yearlyMinor)} a year ·{" "}
          {cash(data.totals.toCancelYearlyMinor)} a year marked to cancel
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <RecentChanges changes={data.changes} money={cash} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showLapsed}
          onChange={(e) => setShowLapsed(e.target.checked)}
        />
        Also show ones that seem to have stopped
      </label>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1 font-medium">Merchant</th>
              <th className="py-1 font-medium">How often</th>
              <th className="py-1 text-right font-medium">Usual</th>
              <th className="py-1 text-right font-medium">Per year</th>
              <th className="py-1 font-medium">Last / next</th>
              <th className="py-1 font-medium">Your decision</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.key} className="border-t border-slate-100 align-top dark:border-slate-800">
                <td className="py-1.5">
                  <div className="font-medium">{s.merchant}</div>
                  <div className="text-xs text-slate-500">{s.accountNames.join(", ")}</div>
                  {s.priceChange && (
                    <div className="text-xs text-amber-700 dark:text-amber-400">
                      Price went from {cash(s.priceChange.fromMinor)} to{" "}
                      {cash(s.priceChange.toMinor)} on {formatDay(s.priceChange.date)}
                    </div>
                  )}
                  {s.chargedAfterCancel && (
                    <div className="text-xs font-medium text-red-600">
                      Still charged after you cancelled it
                    </div>
                  )}
                </td>
                <td className="py-1.5">{CADENCE_LABEL[s.cadence as Cadence] ?? s.cadence}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {cash(s.typicalAmountMinor)}
                  {s.amountVaries && <span className="text-xs text-slate-400"> varies</span>}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {cash(s.yearlyMinor)}
                </td>
                <td className="py-1.5 text-xs text-slate-500">
                  {formatDay(s.lastDate)}
                  <br />
                  {s.status === "active"
                    ? `next ${formatDay(s.nextExpected)}`
                    : "seems to have stopped"}
                </td>
                <td className="py-1.5">
                  <Select
                    aria-label={`Decision for ${s.merchant}`}
                    value={s.review?.status ?? ""}
                    onChange={(e) => void decide(s, e.target.value as SubscriptionStatus | "")}
                    className="rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600"
                  >
                    {DECISIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1.5 text-right">
                  {trackedKeys.has(s.key) ? (
                    <span className="text-xs text-slate-500">Tracked</span>
                  ) : (
                    <button
                      type="button"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                      onClick={() => onTrack(s)}
                      title="Add it to your subscriptions, with the details of the account"
                    >
                      Track
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-slate-500">
                  No recurring charges found yet. They show up after a few months of history.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const CHANGE_TEXT: Record<RecurringChange["kind"], string> = {
  price_up: "Price went up",
  price_down: "Price went down",
  new: "New recurring charge",
  charged_after_cancel: "Still charged after you cancelled it",
};

/** Recent price changes, new recurring charges, and charges after cancelling, newest first. */
function RecentChanges({
  changes,
  money: cash,
}: {
  changes: RecurringChange[];
  money: (n: number) => string;
}) {
  return (
    <section
      aria-label="What changed recently"
      className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
    >
      <h3 className="text-sm font-semibold">What changed recently</h3>
      {changes.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">
          No price changes or new recurring charges in the last few months.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {changes.map((c) => {
            const bad = c.kind === "price_up" || c.kind === "charged_after_cancel";
            return (
              <li
                key={`${c.key}-${c.kind}`}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span>
                  <span
                    className={`mr-2 rounded-xl px-2 py-0.5 text-xs font-medium ${
                      bad
                        ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                        : c.kind === "price_down"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                          : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    }`}
                  >
                    {CHANGE_TEXT[c.kind]}
                  </span>
                  <span className="font-medium">{c.merchant}</span>
                  <span className="text-slate-500">
                    {" "}
                    {c.fromMinor !== null
                      ? `${cash(c.fromMinor)} → ${cash(c.toMinor)}`
                      : cash(c.toMinor)}
                    {" · "}
                    {c.kind === "new" ? "since" : "on"} {formatDay(c.date)}
                  </span>
                </span>
                <span
                  className={`tabular-nums ${c.yearlyDeltaMinor > 0 ? "text-red-600" : "text-green-700 dark:text-green-400"}`}
                >
                  {c.yearlyDeltaMinor > 0 ? "+" : "−"}
                  {cash(Math.abs(c.yearlyDeltaMinor))} a year
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
