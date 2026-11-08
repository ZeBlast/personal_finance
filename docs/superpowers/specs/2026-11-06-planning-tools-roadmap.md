# Planning tools: what to add next

_Roadmap, 2026-11-06. Drafted from a read-through of the app; the user asked for a plan without a Q&A round, so the priorities below are my calls and are marked as such._

## What the app already has for planning

| Tool | Where | What it answers |
| --- | --- | --- |
| Cash-flow forecast | Planning > Forecast & bills | Bank cash day by day for up to 180 days: expected items, detected recurring, card bills, debt-plan extra (`forecast.service.ts`) |
| Daily brief | Dashboard | Safe to spend until next income = lowest cash before payday − goal money − buffer (`brief.service.ts`) |
| Card bills, paychecks | Planning tabs | When cards are due; detected pay dates |
| Calendar planned items | Calendar | One-off or repeating expected transactions, with exceptions |
| Subscriptions + Coming up | Planning > Subscriptions | Trials, renewals, price rises |
| Spending caps | Planning > Spending caps | Per-category monthly caps, repeating, rollover, pace, sinking funds (`fund_target_*`) |
| Goals | Planning > Goals | Target, date, linked accounts, needed per month |
| Debt payoff | Planning > Debt payoff | Avalanche/snowball with extra payment, vs minimums only |
| Spending monitors | Reports | A slice of spending vs usual, with month-end pace |
| What-if calculator | What-if | Node playground: income, expenses, maths, taxes, "From my data" averages; cash-flow map |
| TSP outlook | Accounts > Investments | Retirement range from the funds' real yearly returns |
| Reminders | Settings | Bills due, sign-ins, caps nearly used |

**The gap.** Each piece answers its own question well, but they do not talk to each other:

- The What-if calculator works in yearly totals with no dates, so it cannot say what a change does to _next month's cash_, a goal's date, or the debt-free date.
- Nothing puts a month's income next to everything it has to cover (bills, subscriptions, caps, goal saving, debt extra) and says what is left. Goals ask for "$X per month" without checking that $X exists.
- Planning stops at 180 days (forecast) or jumps to retirement (TSP only). There is no 1-year or 10-year view of the whole picture.

So the theme of this roadmap is **connect the pieces you already have**, rather than add more standalone calculators.

## Proposed tools, in recommended order

### 1. Scenarios — "what if" on your real forecast

**What it is.** A named scenario is a short list of changes laid over your real data. The app shows _now_ vs _with this scenario_ side by side.

Changes a scenario can hold:
- a one-off amount on a date (a vacation, a car repair, a bonus)
- a new repeating amount from a date (new rent, a raise, a car payment)
- stop a detected recurring item or subscription from a date
- change the debt plan's extra payment, or a cap, from a date

What it shows, both ways:
- the forecast line (two lines on one chart) and its lowest point
- safe to spend today
- each goal's projected reach date
- the debt-free date and total interest

**Why first.** Biggest payoff for the least new machinery: `cashForecast` already builds a day-by-day list of events, and `simulatePayoff` already projects debt. A scenario is extra events fed into the same functions.

**Build notes.**
- Backend: let `cashForecast` take an extra list of events (and a list of series keys to drop). New table `scenarios` (name, changes as JSON). Route `POST /scenarios/:id/preview` returns baseline and scenario summaries.
- "Make it real": turn a scenario's changes into calendar planned items (and dismiss stopped series) in one step, with Undo.
- Lives as a second tab on the What-if area ("Scenarios" beside "What-if calculator"). _My call_; it could equally live under Planning.
- Horizon: the forecast's 180 days for cash; months for goals and debt (they already work in months).

### 2. Can I afford it? — a quick front door to scenarios

**What it is.** Type an amount (and optionally a date). The answer is one of:
- **Yes, on that date.** Cash stays above your buffer; lowest point is $Y on day Z. Safe to spend drops by $W.
- **Not then — earliest is {date}.** The first day the purchase keeps cash above the buffer through the forecast.
- **Save for it.** $N a month gets you there by {date}, with a button that creates the goal.

**Why.** It is the question people actually ask, and it is a thin layer on scenario 1 (a one-off change, searched over dates).

**Build notes.** A dashboard widget (registered in `frontend/src/widgets/registry`, so no server change for placement), plus an entry in the search palette. Optionally "and on the card": a card purchase lands on the card bill's due day rather than today, which the forecast already understands.

### 3. Month plan — every dollar of the month in one place

**What it is.** One screen per month:

```
Expected income            (detected paychecks + expected deposits)
− Bills and subscriptions  (recurring, card bills, planned items)
− Spending caps            (sum of this month's caps, sinking funds included)
− Goal saving              (each goal's per-month amount; editable for the month)
− Debt extra               (the payoff plan's extra)
= Left to plan             (green when ≥ 0, red when short)
```

During and after the month, each line shows planned vs actual, and "Start next month from this one" copies it forward (caps already have `copyBudgets`).

**Why.** It answers "is this all affordable?" Today goals can ask for more per month than you have left, and nothing says so. This makes the existing caps, goals and debt extra add up to a plan.

**Build notes.**
- Mostly a read-only roll-up over existing services: `paycheck`, `recurring`, `bills`, `budget`, `goal`, `debt`. New stored data is small: a per-month goal amount override (otherwise use `perMonthMinor`).
- Feeds the Month report ("plan vs actual") and the daily brief (goal saving already reduces safe to spend).
- Warn on the Goals page when the goals' per-month total is more than the typical monthly surplus (average income minus spending, the same numbers the What-if "From my data" node uses), and suggest realistic dates.
- Place under Planning, first tab. _My call._

### 4. Year ahead — the lumpy months, 12 months out

**What it is.** A 12-month strip, one column per month, each with expected income, expected spending and the known lumpy items: annual subscriptions and renewals, insurance, three-paycheck months, card annual fees, goal target dates, debts paid off, sinking-fund targets, expected tax refund or payment. Months that are short are marked, with what makes them short.

**Why.** The forecast stops at 180 days and works day by day. Most surprises are yearly (car insurance, holidays, the annual Amazon renewal). This is where you see them coming and set up a sinking fund in time.

**Build notes.** Month-level, not day-level, so it can run 12 months without the forecast's cost. Reuse `nextAfter` for recurring items, planned occurrences, renewals from tracked subscriptions, and the debt plan's month-by-month balances. A "Save for this" button on any lumpy item creates a sinking fund cap (`fund_target_minor`/`fund_target_date`), which already exists.

### 5. Long-range outlook — net worth over years

**What it is.** A chart from today's net worth forward 1–30 years, with a low/middle/high band:
- savings from your real average surplus (adjustable)
- investment growth: the TSP outlook's method generalized to every investment account (a range of steady rates where fund history is missing)
- debts falling per the payoff plan
- milestones on the line: debt-free, each goal reached, an emergency fund of N months, and a "work optional" number (yearly spending × 25, adjustable)

**Why.** It is the "am I on track?" view, and the only place all of savings, investments and debt meet. Today retirement planning exists only for TSP accounts.

**Build notes.** Mostly frontend maths in the style of `frontend/src/lib/retirement.ts`, fed by the net-worth series and debt overview. Scenarios (tool 1) can later apply here too ("what does a $5k raise do to the work-optional date?").

### 6. Safety net — how long your cash would last (small, can go any time)

**What it is.** One number: months of _essential_ spending your cash (minus goal money) would cover, with a target (3 or 6 months) and a one-click emergency-fund goal.

**Build notes.** Needs one new thing: marking categories as essential. Add a boolean column on `categories` (default by name for the starter pack: rent, utilities, groceries, insurance, loans). Then it is a dashboard widget and a milestone in tool 5. Essential vs flexible also improves the Month plan (show the floor you cannot cut).

## Considered and left out

- **Paycheck-to-bill assignment** ("this paycheck covers rent, the next covers the card"): the forecast and lowest-balance already catch the timing problem it solves. Revisit if pay is biweekly and bills cluster.
- **Refinance / balance-transfer compare** for debt: useful but narrow; fits later as a scenario change type ("move this balance to 0% for 15 months, 3% fee").
- **Tax withholding check** ("will I owe in April?"): the Taxes page and the What-if tax nodes make it possible, but it needs paystub withholding data the app does not have.
- **Another standalone calculator** of any kind: the roadmap's point is connecting what exists.

## Suggested order and sizing

| # | Tool | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Scenarios | Medium-large | forecast + debt services |
| 2 | Can I afford it? | Small | 1 |
| 3 | Month plan | Medium | existing services; nicer with 6 |
| 4 | Year ahead | Medium | — |
| 5 | Long-range outlook | Medium | nicer with 1 and 6 |
| 6 | Safety net | Small | — (quick win; could ship first) |

Each is its own project: each should get its own design document and implementation plan before building, in this order unless the user re-orders.

## Open questions for the user

1. Which of these would you actually open weekly? That should probably go first, over my order.
2. Month plan: is "every dollar gets a job" (left to plan = $0) how you want to plan, or is "am I short?" enough?
3. Should "work optional" / retirement be in scope at all, or is TSP's outlook enough?
