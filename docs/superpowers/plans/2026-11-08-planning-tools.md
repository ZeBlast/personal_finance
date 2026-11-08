# Planning Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five planning tools — Safety net, Can I afford it?, Month plan, Year ahead, Long-range outlook — that connect the planning pieces the app already has.

**Architecture:** One backend service per tool under `backend/src/services/`, read-only roll-ups over existing services (forecast, recurring, budgets, goals, debt, analytics), served from one new routes file. Two tools are dashboard widgets (one file each, auto-registered); three are new Planning tabs. Pure maths sits in small exported functions with unit tests; services get one route-level test each through `makeTestApp`.

**Tech Stack:** Node/Express/Drizzle/zod/vitest (backend), React/TypeScript/Tailwind/vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-11-06-planning-tools-roadmap.md` (tool 1, Scenarios, already exists on `master` and is out of scope).

## Global Constraints

- Branch `planning-tools` from `master`. Tests only ever use `makeTestApp` throwaway databases — never the real data folder.
- Money is integer minor units (`…Minor`), the settings currency only; accounts in another currency are left out, as `brief.service.ts` does.
- Cash = the brief's cash accounts: `countsInTotals`, `type === "depository"`, settings currency, has a balance, and manual or in the active Plaid environment.
- Goal money in cash is not free money: subtract `goalReservations` for those accounts (as the brief does).
- Recurring series count only when `status === "active"`, not `dismissed`, and not cancelled (`cancelledSeries` in `forecast.service.ts`, to be exported).
- Copy is plain English, sentence case, no jargon — match existing pages ("What you can spend…").
- No new database tables or migrations: essentials live in settings.

## Review Focus

1. **A brand-new install with no accounts or transactions** — every endpoint answers with zeros/nulls and every screen shows an empty state, never an error. (Test in Tasks 1, 3, 5, 7, 9.)
2. **Essentials that point at a deleted or archived category** — ignored, not counted, not crashing. (Task 1.)
3. **An amount bigger than the forecast can ever cover** — "Can I afford it?" says no date works and still offers save-for-it plans. (Task 3.)
4. **A cancelled subscription or dismissed recurring series** — left out of Month plan and Year ahead. (Tasks 5, 7.)
5. **A capped category that also has a recurring bill** (utilities) — counted once, under the cap. (Task 5.)

---

### Task 1: Essentials setting and Safety net service

**Files:**
- Modify: `backend/src/services/settings.service.ts` (schema + default), `frontend/src/types/api.ts` (Settings type)
- Modify: `backend/src/services/brief.service.ts` — extract `cashAccounts(db, settings)` and `goalMoneyInCash(db, accounts)`; brief uses them unchanged
- Modify: `backend/src/services/forecast.service.ts` — export `cancelledSeries`
- Create: `backend/src/services/safety-net.service.ts`, `backend/src/routes/plan-tools.routes.ts`; mount in `backend/src/app.ts`
- Test: `backend/src/safety-net.test.ts`

**Interfaces — Produces:**
- Setting `essentialCategoryIds: number[]` (max 500, default `[]`).
- `cashAccounts(db: AppDb, settings: Settings): AccountDto[]` and `goalMoneyInCash(db: AppDb, accounts: AccountDto[]): { reservedMinor: number; reservedFor: Array<{ accountName: string; amountMinor: number }> }` exported from `brief.service.ts`.
- `runwayMonths(freeCashMinor: number, monthlyMinor: number): number | null` — null when monthly ≤ 0; never negative (free cash below 0 → 0); one decimal.
- `safetyNet(db, { today? }): SafetyNet` with `SafetyNet = { currency, cashMinor, reservedMinor, freeCashMinor, monthlyMinor, basis: "essential" | "all", monthsAveraged, months: number | null, essentials: Array<{ id: number; name: string; monthlyMinor: number }> }`.
- `GET /api/safety-net`.

Rules: average over the 3 complete months before today's month; `monthsAveraged` = how many of those 3 had any spending (min 1). A chosen parent includes its subcategories. Inactive or missing ids are dropped. With no valid essentials, `basis: "all"` and every category's spending counts.

- [ ] **Step 1: Failing tests** — `runwayMonths(30_000, 10_000) === 3`, `runwayMonths(-5, 10_000) === 0`, `runwayMonths(5, 0) === null`; route test on an empty app returns `{ cashMinor: 0, months: null, basis: "all" }`; with a savings account of $6,000, a $1,000 goal on it, and 3 complete months of $1,000 rent + $500 fun, essentials `[rent]` → `freeCashMinor 500_000`, `monthlyMinor 100_000`, `months 5`; essentials `[rent, 99999]` behaves the same.
- [ ] **Step 2:** Run `npm test -w backend -- safety-net` → FAIL.
- [ ] **Step 3:** Implement as above; `summarize(db, { groupBy: "category", includeTransfers: false, includePending: false, fill: false, environment })` per month.
- [ ] **Step 4:** Run tests → PASS; run `brief` tests too.
- [ ] **Step 5:** Commit "Safety net: how many months your cash covers, from the categories you call essential".

### Task 2: Safety net widget

**Files:** Create `frontend/src/widgets/SafetyNetWidget.tsx`, `frontend/src/lib/planTools.ts`, `frontend/src/lib/planTools.test.ts`, `frontend/src/types/planTools.ts`.

**Interfaces — Consumes:** `GET /safety-net`, `PATCH /settings { essentialCategoryIds }`, `GET /categories`.
**Produces:** `runwayText(s: SafetyNet, targetMonths: number): { headline: string; detail: string; tone: "good" | "warn" | "none" }` in `planTools.ts`.

Widget `id: "safety-net"`, group `Accounts`, config `{ target: 6 }` (number 1–24). Shows months (big), "of 6 months" bar, the line "Covers $X a month of essentials, from $Y cash after goals", and a "Choose essentials" button opening a `Modal` with top-level category checkboxes. With `basis: "all"`, say "Counting all spending — choose your essentials for a truer figure."

- [ ] **Step 1: Failing tests** for `runwayText`: months 7 target 6 → tone good, headline "7 months"; months 2.5 → warn, headline "2.5 months"; months null → tone none, headline "No spending yet".
- [ ] **Step 2–4:** Run `npm test -w frontend -- planTools` FAIL → implement → PASS; `widgets.test.ts` passes (contract check).
- [ ] **Step 5:** Commit "Safety net widget, with a picker for essential categories".

### Task 3: Can I afford it? service

**Files:** Create `backend/src/services/afford.service.ts`; modify `plan-tools.routes.ts`; test `backend/src/afford.test.ts`.

**Interfaces — Produces:**
- `suffixLows(days: Array<{ date: string; balanceMinor: number }>): number[]` — `out[i]` = min balance of `days[i..]`. Pure.
- `affordOn(days, amountMinor, floorMinor, date): { ok: boolean; lowest: { date: string; balanceMinor: number } }` — buying on `date` lowers every day ≥ date; `lowest` is the lowest day ≥ date after the purchase. Pure.
- `earliestAffordable(days, amountMinor, floorMinor): string | null`. Pure, O(n).
- `affordCheck(db, { amountMinor, date?, bufferMinor?, days?, today? }): AffordAnswer` with `AffordAnswer = { currency, today, amountMinor, bufferMinor, reservedMinor, floorMinor, horizonEnd, alreadyShort: boolean, asked: { date, ok, lowest, marginMinor } | null, earliest: { date, lowest } | null, plans: Array<{ months: 3 | 6 | 12; perMonthMinor: number; by: string }> }`.
- `GET /api/afford?amountMinor&date&bufferMinor&days` (amount 1…100_000_000_000; days 30–180, default 90; date must be today…horizonEnd else 400 `date_out_of_range`).

`floorMinor = reservedMinor + bufferMinor`. `alreadyShort` = the base forecast's lowest (`lowestBalance`) is below the floor. `perMonthMinor = ceil(amount / months)`, `by` = today + months (`addMonths`, same day).

- [ ] **Step 1: Failing tests** — days `[100,80,120,60,200]` (×100) on consecutive dates: `suffixLows` → `[60,60,60,60,200]`; `affordOn(…, 50, 0, d0)` ok with lowest `{d3, 10}`; `affordOn(…, 70, 0, d0)` not ok; `earliestAffordable(…, 70, 0)` = `d4`; `earliestAffordable(…, 500, 0)` = null. Route: empty app, `amountMinor=100` → `earliest: null`, three plans; `date` in the past → 400.
- [ ] **Step 2–4:** FAIL → implement over one `cashForecast(db, { days, today })` → PASS.
- [ ] **Step 5:** Commit "Can I afford it: the earliest day a purchase keeps your cash above goals and a buffer".

### Task 4: Can I afford it? widget

**Files:** Create `frontend/src/widgets/AffordWidget.tsx`; add `affordSentence(a: AffordAnswer, money): { headline: string; detail: string; ok: boolean | null }` to `planTools.ts` + tests.

Widget `id: "afford"`, group `Tools`, config `{ buffer: 0 }`. Form: amount, optional "What is it?" (max 60), optional date. Answer lines:
- asked & ok → "Yes, on {day}." / "Your cash is lowest on {day} at {money}, {margin} above what you keep."
- asked & not ok, earliest → "Not on {day}. The earliest is {earliest}."
- no earliest → "Not in the next {n} days." plus plans: "Save {perMonth} a month for {m} months" with **Make it a goal** → `POST /goals { name: what || "A purchase", targetMinor, targetDate: by }`, toast on success.
- alreadyShort adds "Your forecast already dips below your goals and buffer."

- [ ] Steps: failing `affordSentence` tests for the three cases → implement → PASS → commit "Can I afford it widget, with save-for-it goals".

### Task 5: Month plan service

**Files:** Create `backend/src/services/plan-dates.ts`, `backend/src/services/month-plan.service.ts`; modify routes; tests `backend/src/plan-dates.test.ts`, `backend/src/month-plan.test.ts`.

**Interfaces — Produces:**
- `seriesDatesIn(lastDate: string, cadence: Cadence, from: string, to: string): string[]` — the series' dates in `[from, to]`, walking back from `lastDate` by its cadence then forward with `nextAfter`. Pure. Used by Tasks 5 and 7.
- `activeSeries(db, today): RecurringSeries[]` in `plan-dates.ts` — active, not dismissed, not cancelled (on or before the month's start).
- `monthPlan(db, { month?, today? }): MonthPlan`:

```ts
type PlanKind = "income" | "bill" | "cap" | "usual" | "goal" | "debt";
interface PlanLine { kind: PlanKind; label: string; amountMinor: number; note?: string }
interface MonthPlan {
  currency: string; month: string; today: string;
  lines: PlanLine[];               // amounts positive; kind says direction
  totals: Record<PlanKind, number>;
  leftMinor: number;               // income − everything else
  actual: { incomeMinor: number; spendingMinor: number; through: string } | null; // null for future months
}
```

- `GET /api/month-plan?month=YYYY-MM` — month within 12 back … 6 ahead of today's, else 400.

Rules: **income** = incoming active series × `seriesDatesIn` count + incoming planned occurrences (`listOccurrences`). **bill** = outgoing series and planned occurrences whose category has no cap this month. **cap** = each cap in `budgetMonth(db, month)` at its amount for the month. **usual** = each uncapped category's `averageMinor` minus bills already counted in it, when > 0, label "Usual {category}". **goal** = unreached goals: `forecast?.monthlyMinor ?? perMonthMinor`, skip 0/null. **debt** = `settings.debtExtraInForecastMinor` when > 0. **actual** = `summarize` from the 1st to min(today, month end).

- [ ] **Step 1: Failing tests** — `seriesDatesIn("2026-11-14", "biweekly", "2026-10-01", "2026-10-31")` → `["2026-10-03","2026-10-17","2026-10-31"]`; monthly `"2026-11-05"` in Dec → `["2026-12-05"]`. Route: empty app → `lines: []`, `leftMinor: 0`; seeded app with a monthly paycheck $3,000, a monthly utility $100 in a category capped at $150, a cancelled $15 subscription, a $200/month goal → income 300_000, cap 15_000, no utility bill line, no subscription line, goal 20_000, `leftMinor` 265_000.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Month plan: a month's income next to everything it has to cover".

### Task 6: Month plan page

**Files:** Create `frontend/src/pages/MonthPlanPage.tsx`; modify `frontend/src/app/routes.tsx` (tab `{ path: "/planning/month", label: "Month plan" }` right after Cash forecast); `planTools.ts` gets `leftLine(p: MonthPlan, money): { text: string; tone: "good" | "short" }` + tests; add page summary if `lib/pageSummaries.ts` requires every route.

Layout: month picker (‹ month ›), big "Left to plan" figure, then grouped sections (Income, Bills, Spending caps, Usual spending, Goals, Debt) each with a total and its lines; each section header links to its page (caps → `/planning/budgets`, goals → `/planning/goals`, debt → `/planning/debt`). For the current month a strip "So far: {in} in, {out} spent, through {day}".

- [ ] Steps: failing `leftLine` tests (left 0 → "Every dollar has a job"; > 0 → "{x} not yet planned"; < 0 → "{x} short", tone short) → implement page → PASS → frontend typecheck → commit "Month plan page under Planning".

### Task 7: Year ahead service

**Files:** Create `backend/src/services/year-ahead.service.ts`; modify routes; test `backend/src/year-ahead.test.ts`.

**Interfaces — Produces:** `yearAhead(db, { today? }): YearAhead` and `GET /api/year-ahead`:

```ts
type YearItemKind = "yearly" | "quarterly" | "planned" | "extra_paycheck" | "goal_date" | "debt_paid_off" | "fund_target";
interface YearItem { date: string; label: string; amountMinor: number /* signed */; kind: YearItemKind }
interface YearMonth { month: string; incomeMinor: number; billsMinor: number; capsMinor: number; netMinor: number; short: boolean; items: YearItem[] }
interface YearAhead { currency: string; today: string; months: YearMonth[] /* 12, starting this month */ }
```

Rules: income/bills from `activeSeries` × `seriesDatesIn` and planned occurrences, same cap de-duplication as Task 5; caps from `budgetMonth` per month. Items: quarterly/yearly series occurrences; planned items that do not repeat; a month where an incoming weekly/biweekly series has more dates than its usual (biweekly 3, weekly 5) → `extra_paycheck`; unreached goals' `targetDate`; `debtOverview(db).plan.debts[].payoffMonth` → that month; caps with `fundTargetDate`. `short = netMinor < 0`.

- [ ] **Step 1: Failing tests** — empty app → 12 months all zero, no items; seeded: yearly $600 insurance last paid 2026-03-10 → item in March 2027 window month; biweekly paycheck → exactly the months with 3 dates carry `extra_paycheck`; a dismissed yearly series → no item.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit "Year ahead: the next twelve months with their lumpy costs".

### Task 8: Year ahead page

**Files:** Create `frontend/src/pages/YearAheadPage.tsx`; tab `{ path: "/planning/year", label: "Year ahead" }` after Month plan; `planTools.ts` `itemLabel(kind)` + `shortMonths(y: YearAhead): string[]` + tests.

Layout: a 12-column strip (wraps to 3×4 / 2×6 on narrow screens): month name, net (red only when short), income/out mini bars, item chips. Under it a list of items by date with **Save for this** on outgoing ones → `POST /budgets` creating a sinking fund (`fundTargetMinor`, `fundTargetDate`) in a chosen category via `CategorySelect`, months to target shown as "{x} a month".

- [ ] Steps: failing helper tests → implement → PASS → typecheck → commit "Year ahead page, with save-for-this sinking funds".

### Task 9: Long-range outlook inputs

**Files:** Create `backend/src/services/outlook.service.ts`; modify routes; test `backend/src/outlook.test.ts`.

**Interfaces — Produces:** `outlookInputs(db, { today? }): OutlookInputs` and `GET /api/outlook`:

```ts
interface OutlookInputs {
  currency: string; today: string;
  cashMinor: number; investmentsMinor: number; otherAssetsMinor: number; debtMinor: number; netWorthMinor: number; // from overview()
  monthlyIncomeMinor: number; monthlySpendingMinor: number; monthsAveraged: number; // last 12 complete months with any activity
  debtBalances: number[];           // debtOverview(db).plan.balances (month 0 = now)
  debtFreeMonths: number | null;    // plan.months
  goals: Array<{ name: string; targetDate: string | null; remainingMinor: number }>;
}
```

- [ ] Steps: empty app → zeros, `monthsAveraged: 0`, `debtBalances: [0]` or `[]` (whatever the plan returns, pinned in the test); seeded income/spending over 2 months → averages over 2 → implement → PASS → commit "Long-range outlook: the figures it starts from".

### Task 10: Long-range outlook page

**Files:** Create `frontend/src/lib/outlook.ts` + `frontend/src/lib/outlook.test.ts`, `frontend/src/pages/OutlookPage.tsx`; tab `{ path: "/planning/outlook", label: "Long-range" }` last in Planning.

**Interfaces — Produces:**
- `projectOutlook(i: OutlookInputs, o: { years: number; savingPerMonthMinor: number; rates: [number, number, number]; multiple: number }): { points: Array<{ year: number; low: number; mid: number; high: number }>; workOptionalYear: number | null; debtFreeYear: number | null }`.

Model, per year k (0…years): investments(k) = investments(k−1)·(1+r) + saving·12; cash and other assets stay; debt = `debtBalances[12k]` (0 past the end); net = cash + investments + other − debt. `workOptionalYear` = first k where mid cash + investments ≥ multiple × monthlySpending × 12. Defaults: years 30, rates `[0.03, 0.05, 0.07]`, multiple 25, saving = max(0, income − spending).

Page: inputs (saving a month, years, the three rates, multiple) with the "from your last N months" note, a `LineChart` of mid with a low–high band, milestone list (debt-free, each goal's date, work-optional), and a plain note that it is an estimate in today's dollars.

- [ ] **Step 1: Failing tests** — inputs investments 100_000, saving 0, rate 0.05, 1 year → mid year 1 = 105_000; saving 1_000/month, rate 0 → year 1 adds 12_000; spending 1_000/month, multiple 25, investments 300_000 → `workOptionalYear 0`; debtFreeMonths 18 → `debtFreeYear 2`.
- [ ] **Step 2–4:** FAIL → implement → PASS → typecheck.
- [ ] **Step 5:** Commit "Long-range outlook page: net worth over the years, with milestones".

### Task 11: Finish

- [ ] Update `README.md` feature bullets and the roadmap doc (Scenarios already shipped; what got built).
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check` → all pass.
- [ ] Whole-branch review (superpowers:requesting-code-review), fix findings, commit.
