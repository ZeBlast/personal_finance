import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { inputClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { MARYLAND_COUNTIES } from "../lib/sandbox/dmvTaxes";
import { FILING_STATUSES, type FilingStatus } from "../lib/sandbox/taxes";
import {
  annualOf,
  estimateTaxes,
  suggestAnnual,
  type SourceInput,
  type TaxInputs,
} from "../lib/taxes/estimate";
import { formatDay } from "../lib/time";
import { Select } from "../components/common/Select";

interface IncomeTx {
  id: number;
  date: string;
  merchant: string;
  amountMinor: number;
  accountName: string;
  categoryName: string | null;
  kind: "income" | "credit";
  source: string;
  pending: boolean;
}

interface IncomeSource {
  key: string;
  label: string;
  kind: "income" | "credit";
  totalMinor: number;
  count: number;
  firstDate: string;
  lastDate: string;
  wages: boolean;
  /** Regular pay found for this source, with the year's projection. */
  paycheck: {
    cadence: string;
    typicalMinor: number;
    nextExpected: string;
    paydaysLeft: number;
    projectedYearMinor: number;
  } | null;
}

type SavedSource = Omit<SourceInput, "suggested" | "kind">;
type Profile = Omit<TaxInputs, "year" | "sources"> & { sources: SavedSource[] };

interface TaxData {
  year: number;
  transactions: IncomeTx[];
  sources: IncomeSource[];
  profile: Profile | null;
}

const DEFAULT_PROFILE: Profile = {
  filingStatus: "single",
  state: "none",
  marylandCounty: null,
  customLocalRate: null,
  customLocalName: null,
  federalWithheld: null,
  stateWithheld: null,
  sources: [],
};

const PAY_CADENCE: Record<string, string> = {
  weekly: "every week",
  biweekly: "every 2 weeks",
  semimonthly: "twice a month",
  monthly: "every month",
};

const usd = (dollars: number): string => formatMinor(Math.round(dollars * 100), "USD");
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
/** A number box's value: empty is null. */
const num = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Estimates the year's federal, state, and local taxes from the income the app has seen. */
export function TaxesPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const { data, error, loading } = useApi<TaxData>(`/taxes/${year}`);
  return (
    <section className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Taxes</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            An estimate of the year&apos;s taxes from your income and credits. Fill in what the
            transactions can&apos;t tell: a source&apos;s full-year pay, pre-tax contributions, and
            where you live. It is an estimate, not tax advice.
          </p>
        </div>
        <label className="text-sm">
          Tax year
          <Select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className={inputClass}
          >
            {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && data.year === year && <TaxWorkspace key={year} data={data} />}
    </section>
  );
}

function TaxWorkspace({ data }: { data: TaxData }) {
  const [profile, setProfile] = useState<Profile>(() => ({
    ...DEFAULT_PROFILE,
    ...(data.profile ?? {}),
  }));
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | null>(null);
  const [showTx, setShowTx] = useState(false);

  // Save a moment after each change (not on first show).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaveState("saving");
    const timer = setTimeout(() => {
      api(`/taxes/${data.year}/profile`, { method: "PUT", body: JSON.stringify(profile) })
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [profile, data.year]);

  // Sources found in the transactions, with the answers saved for them; then ones added by hand.
  const sources: SourceInput[] = useMemo(() => {
    const saved = new Map(profile.sources.map((s) => [s.key, s]));
    const today = new Date();
    const found: SourceInput[] = data.sources.map((s) => {
      const answer = saved.get(s.key);
      return {
        key: s.key,
        label: s.label,
        kind: s.kind,
        // A paycheck's schedule gives the best estimate: paid so far, plus the paydays left.
        suggested: s.paycheck
          ? s.paycheck.projectedYearMinor / 100
          : suggestAnnual(s, data.year, today),
        annualIncome: answer?.annualIncome ?? null,
        // Only pay has FICA taken out; credits, interest, and money from people do not.
        ficaExempt: answer?.ficaExempt ?? !(s.kind === "income" && s.wages),
        pretaxRetirement: answer?.pretaxRetirement ?? 0,
        pretaxBenefits: answer?.pretaxBenefits ?? 0,
        excluded: answer?.excluded ?? false,
      };
    });
    const manual: SourceInput[] = profile.sources
      .filter((s) => s.key.startsWith("manual:"))
      .map((s) => ({ ...s, kind: "manual", suggested: 0 }));
    return [...found, ...manual];
  }, [data, profile.sources]);

  const estimate = estimateTaxes({ ...profile, year: data.year, sources });

  const set = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }));
  const setSource = (s: SourceInput, patch: Partial<SavedSource>) =>
    setProfile((p) => {
      const current: SavedSource = {
        key: s.key,
        label: s.label,
        annualIncome: s.annualIncome,
        ficaExempt: s.ficaExempt,
        pretaxRetirement: s.pretaxRetirement,
        pretaxBenefits: s.pretaxBenefits,
        excluded: s.excluded,
      };
      const next = { ...current, ...patch };
      // Keep each source in its place (sources added by hand are listed in this order).
      return p.sources.some((x) => x.key === s.key)
        ? { ...p, sources: p.sources.map((x) => (x.key === s.key ? next : x)) }
        : { ...p, sources: [...p.sources, next] };
    });
  const addSource = () =>
    setProfile((p) => ({
      ...p,
      sources: [
        ...p.sources,
        {
          key: `manual:${Date.now()}`,
          label: "New income source",
          annualIncome: null,
          ficaExempt: false,
          pretaxRetirement: 0,
          pretaxBenefits: 0,
          excluded: false,
        },
      ],
    }));
  const removeSource = (key: string) =>
    setProfile((p) => ({ ...p, sources: p.sources.filter((s) => s.key !== key) }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <Panel
          title="Income sources"
          aside={
            <button
              type="button"
              onClick={addSource}
              className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
            >
              + Add a source
            </button>
          }
        >
          <p className="mb-3 text-xs text-slate-500">
            Found from money in that counts as income (pay, people paying you, and the Transfers
            &gt; Credit category). Refunds are left out. Leave the annual amount empty to use what
            the transactions point to for the whole year.
          </p>
          {sources.length === 0 && (
            <p className="text-sm text-slate-500">
              No income found for {data.year}. Add a source by hand.
            </p>
          )}
          <div className="space-y-3">
            {sources.map((s) => (
              <SourceRow
                key={s.key}
                s={s}
                year={data.year}
                found={data.sources.find((x) => x.key === s.key)}
                onChange={(patch) => setSource(s, patch)}
                onRemove={s.kind === "manual" ? () => removeSource(s.key) : undefined}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Where you live and file">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Filing status
              <Select
                value={profile.filingStatus}
                onChange={(e) => set({ filingStatus: e.target.value as FilingStatus })}
                className={inputClass}
              >
                {FILING_STATUSES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              State
              <Select
                value={profile.state}
                onChange={(e) =>
                  set({
                    state: e.target.value as Profile["state"],
                    ...(e.target.value === "MD" ? {} : { marylandCounty: null }),
                  })
                }
                className={inputClass}
              >
                <option value="none">No state income tax / not listed</option>
                <option value="MD">Maryland</option>
                <option value="DC">Washington DC</option>
                <option value="VA">Virginia</option>
              </Select>
            </label>
            {profile.state === "MD" && (
              <label className="text-sm">
                County (county income tax)
                <Select
                  value={profile.marylandCounty ?? ""}
                  onChange={(e) => set({ marylandCounty: e.target.value || null })}
                  className={inputClass}
                >
                  <option value="">Choose a county</option>
                  {MARYLAND_COUNTIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="text-sm">
              Other city or local income tax (name)
              <input
                value={profile.customLocalName ?? ""}
                placeholder="e.g. City tax"
                maxLength={80}
                onChange={(e) => set({ customLocalName: e.target.value || null })}
                className={inputClass}
              />
            </label>
            <label className="text-sm">
              Its rate (% of taxable income)
              <input
                type="number"
                min={0}
                max={20}
                step={0.01}
                value={profile.customLocalRate ?? ""}
                onChange={(e) => set({ customLocalRate: num(e.target.value) })}
                className={inputClass}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            DC and Virginia have no local income tax. Rates are for 2026; later years use them until
            new ones are published.
          </p>
        </Panel>

        <Panel title="Already withheld or paid (optional)">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Federal income tax withheld
              <input
                type="number"
                min={0}
                value={profile.federalWithheld ?? ""}
                onChange={(e) => set({ federalWithheld: num(e.target.value) })}
                className={inputClass}
              />
            </label>
            <label className="text-sm">
              State and local tax withheld
              <input
                type="number"
                min={0}
                value={profile.stateWithheld ?? ""}
                onChange={(e) => set({ stateWithheld: num(e.target.value) })}
                className={inputClass}
              />
            </label>
          </div>
        </Panel>

        <Panel
          title={`Income transactions in ${data.year} (${data.transactions.length})`}
          aside={
            <button
              type="button"
              onClick={() => setShowTx((v) => !v)}
              className="text-sm text-blue-700 hover:underline dark:text-blue-400"
            >
              {showTx ? "Hide" : "Show"}
            </button>
          }
        >
          {showTx && <IncomeTable rows={data.transactions} />}
        </Panel>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <Panel title={`Estimated ${data.year} taxes`}>
          <dl className="space-y-1 text-sm">
            <Row label="Income" value={usd(estimate.grossIncome)} />
            <Row label="Pre-tax contributions" value={`−${usd(estimate.pretax)}`} />
            <Row label="Taxable wages" value={usd(estimate.taxableWages)} strong />
            <Divider />
            <Row
              label="Federal income tax"
              value={usd(estimate.federal.tax)}
              note={`after the ${usd(estimate.federal.deduction)} standard deduction · ${pct(estimate.federal.marginalRate)} bracket`}
            />
            <Row label="Social Security" value={usd(estimate.socialSecurity)} />
            <Row
              label="Medicare"
              value={usd(estimate.medicare)}
              note={`FICA on ${usd(estimate.ficaWages)} of wages`}
            />
            {estimate.stateLines.map((l) => (
              <Row key={l.label} label={l.label} value={usd(l.amount)} note={l.note} />
            ))}
            {estimate.stateLines.length === 0 && (
              <Row label="State and local" value={usd(0)} note="no state chosen" />
            )}
            <Divider />
            <Row label="Total taxes" value={usd(estimate.total)} strong />
            <Row label="Effective rate" value={pct(estimate.effectiveRate)} />
            <Row label="Take-home after taxes and pre-tax" value={usd(estimate.takeHome)} strong />
          </dl>
          {(estimate.federalBalance !== null || estimate.stateBalance !== null) && (
            <dl className="mt-3 space-y-1 border-t border-slate-200 pt-3 text-sm dark:border-slate-700">
              {estimate.federalBalance !== null && (
                <Balance label="Federal" n={estimate.federalBalance} />
              )}
              {estimate.stateBalance !== null && (
                <Balance label="State and local" n={estimate.stateBalance} />
              )}
            </dl>
          )}
          <p className="mt-3 text-xs text-slate-500">
            {estimate.federalYearUsed !== data.year &&
              `Federal figures for ${estimate.federalYearUsed} are used (${data.year}'s are not out). `}
            Uses the standard deduction and no credits (such as the child tax credit).
          </p>
          <p className="mt-1 text-xs text-slate-400" aria-live="polite">
            {saveState === "saving" && "Saving..."}
            {saveState === "saved" && "Saved"}
            {saveState === "error" && "Could not save your answers."}
          </p>
        </Panel>
      </aside>
    </div>
  );
}

function SourceRow({
  s,
  year,
  found,
  onChange,
  onRemove,
}: {
  s: SourceInput;
  year: number;
  found: IncomeSource | undefined;
  onChange: (patch: Partial<SavedSource>) => void;
  onRemove: (() => void) | undefined;
}) {
  return (
    <div
      className={`rounded-md border border-slate-200 p-3 dark:border-slate-700 ${s.excluded ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {s.kind === "manual" ? (
            <input
              aria-label="Source name"
              value={s.label}
              maxLength={200}
              onChange={(e) => onChange({ label: e.target.value })}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm font-medium dark:border-slate-600 dark:bg-slate-800"
            />
          ) : (
            <span className="font-medium">{s.label}</span>
          )}
          <span
            className={`ml-2 rounded-xl px-2 py-0.5 text-xs font-medium ${
              s.kind === "credit"
                ? "bg-teal-100 text-teal-900"
                : s.kind === "manual"
                  ? "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                  : "bg-green-100 text-green-900"
            }`}
          >
            {s.kind === "credit" ? "Credit" : s.kind === "manual" ? "Added by hand" : "Income"}
          </span>
          {found?.paycheck && (
            <p className="mt-0.5 text-xs text-green-700 dark:text-green-400">
              Paycheck: {PAY_CADENCE[found.paycheck.cadence] ?? found.paycheck.cadence}, usually{" "}
              {formatMinor(found.paycheck.typicalMinor, "USD")}
              {found.paycheck.paydaysLeft > 0
                ? ` · ${found.paycheck.paydaysLeft} more payday${found.paycheck.paydaysLeft === 1 ? "" : "s"} this year, next ${formatDay(found.paycheck.nextExpected)}`
                : ""}
            </p>
          )}
          {found && (
            <p className="mt-0.5 text-xs text-slate-500">
              {formatMinor(found.totalMinor, "USD")} so far in {year} from {found.count} transaction
              {found.count === 1 ? "" : "s"} ({formatDay(found.firstDate)} to{" "}
              {formatDay(found.lastDate)})
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!s.excluded}
              onChange={(e) => onChange({ excluded: !e.target.checked })}
            />
            Include
          </label>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${s.label}`}
              className="text-slate-400 hover:text-red-600"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          Annual income ($)
          <input
            type="number"
            min={0}
            value={s.annualIncome ?? ""}
            placeholder={s.suggested ? String(Math.round(s.suggested)) : "0"}
            onChange={(e) => onChange({ annualIncome: num(e.target.value) })}
            className={inputClass}
          />
          {s.annualIncome === null && s.suggested > 0 && (
            <span className="mt-0.5 block text-xs text-slate-500">
              Using {usd(s.suggested)}{" "}
              {found?.paycheck ? "(paid so far plus the paydays left)" : "(from the transactions)"}
            </span>
          )}
        </label>
        <label className="text-sm">
          401(k) / TSP, pre-tax ($)
          <input
            type="number"
            min={0}
            value={s.pretaxRetirement || ""}
            onChange={(e) => onChange({ pretaxRetirement: num(e.target.value) ?? 0 })}
            className={inputClass}
          />
          <span className="mt-0.5 block text-xs text-slate-500">Lowers income tax, not FICA</span>
        </label>
        <label className="text-sm">
          Health, HSA, FSA, pre-tax ($)
          <input
            type="number"
            min={0}
            value={s.pretaxBenefits || ""}
            onChange={(e) => onChange({ pretaxBenefits: num(e.target.value) ?? 0 })}
            className={inputClass}
          />
          <span className="mt-0.5 block text-xs text-slate-500">Lowers income tax and FICA</span>
        </label>
        <label className="flex items-start gap-2 pt-6 text-sm">
          <input
            type="checkbox"
            checked={s.ficaExempt}
            onChange={(e) => onChange({ ficaExempt: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            Exempt from FICA
            <span className="block text-xs text-slate-500">
              No Social Security or Medicare (credits, some student or government jobs)
            </span>
          </span>
        </label>
      </div>
      {annualOf(s) > 0 && s.pretaxRetirement + s.pretaxBenefits > annualOf(s) && (
        <p className="mt-1 text-xs text-amber-700">
          Pre-tax contributions are more than this source pays; only up to its income counts.
        </p>
      )}
    </div>
  );
}

function IncomeTable({ rows }: { rows: IncomeTx[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">None.</p>;
  return (
    <div className="max-h-96 overflow-auto rounded border border-slate-200 dark:border-slate-700">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <tr>
            <th className="px-2 py-2 font-medium">Date</th>
            <th className="px-2 py-2 font-medium">Merchant</th>
            <th className="px-2 py-2 font-medium">From</th>
            <th className="px-2 py-2 font-medium">Category</th>
            <th className="px-2 py-2 font-medium">Account</th>
            <th className="px-2 py-2 text-right font-medium">Amount</th>
            <th className="px-2 py-2 font-medium">Kind</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="px-2 py-1.5 whitespace-nowrap">{formatDay(t.date)}</td>
              <td className="px-2 py-1.5">{t.merchant}</td>
              <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">{t.source}</td>
              <td className="px-2 py-1.5">{t.categoryName ?? "Uncategorized"}</td>
              <td className="px-2 py-1.5">{t.accountName}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap text-green-700 tabular-nums dark:text-green-400">
                +{formatMinor(t.amountMinor, "USD")}
              </td>
              <td className="px-2 py-1.5">
                {t.kind === "credit" ? "Credit" : "Income"}
                {t.pending && " · Pending"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  strong?: boolean;
}) {
  return (
    <div>
      <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
        <dt>{label}</dt>
        <dd className="tabular-nums">{value}</dd>
      </div>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}

function Balance({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd
        className={`tabular-nums ${n > 0 ? "text-red-600" : "text-green-700 dark:text-green-400"}`}
      >
        {n > 0 ? `${usd(n)} still to pay` : `${usd(-n)} coming back`}
      </dd>
    </div>
  );
}

const Divider = () => <hr className="my-2 border-slate-200 dark:border-slate-700" />;
