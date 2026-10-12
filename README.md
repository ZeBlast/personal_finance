# Personal Finance

A single-user personal finance app that runs on your own computer. It is packaged with Tauri as a
Windows desktop app, keeps all data in a local SQLite database, and (from Phase 2 on) syncs your
accounts through Plaid. The same UI can also be opened in a browser tab while the app is running.

The full design and phase plan is in `plan.md` (currently in your Downloads folder; move it into
this folder if you want it under version control). This README only covers how to build and run
what exists so far (Phase 1: the foundation).

## How the pieces fit

```
Tauri window (src-tauri/)        native shell: one window, one running instance
   |  starts / stops
   v
Backend "sidecar" (backend/)     Node + Express + SQLite, compiled into backend.exe
   ^  http://127.0.0.1:<port>    loopback only, protected by a random per-launch token
   |
React UI (frontend/)             shown in the Tauri window, or in a browser tab
```

- `frontend/` React, TypeScript, Vite, Tailwind. The UI never sees a secret other than the
  per-launch token.
- `backend/` Express API, Drizzle ORM, `better-sqlite3`. Business logic lives here.
- `drizzle/` database schema (`schema.ts`) and generated SQL migrations, applied at startup.
- `src-tauri/` the Rust shell. It picks a free port, makes the token, starts the backend and tells
  the UI where it is.
- `scripts/build-sidecar.mjs` bundles the backend into a single `backend.exe`.

## Requirements (Windows)

Node 22+, Rust (stable), Visual Studio C++ Build Tools, and WebView2 (already part of Windows 11).

## Everyday commands

| Command               | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `npm install`         | Install dependencies for all packages                            |
| `npm test`            | Run the backend tests                                            |
| `npm run typecheck`   | Type-check backend and frontend                                  |
| `npm run lint`        | Lint everything                                                  |
| `npm run format`      | Format with Prettier                                             |
| `npm run db:generate` | After editing `drizzle/schema.ts`, generate a new SQL migration  |
| `npm run build`       | Build the Windows installer (`src-tauri/target/release/bundle/`) |

Use `npx tauri build` from a Git Bash or PowerShell prompt if `npm run build` complains about
arguments.

### Develop with hot reload

1. Copy `.env.example` to `.env` (the defaults work; in development a throwaway encryption key
   file is created in the data folder automatically).
2. Terminal 1: `npm run dev:backend` (backend with auto-restart, port 47831).
3. Terminal 2, PowerShell: `$env:PF_EXTERNAL_BACKEND = "1"; npm run dev`.
   (Bash: `PF_EXTERNAL_BACKEND=1 npm run dev`.) The window talks to your running backend instead
   of the compiled one, and the UI hot-reloads.

`PF_EXTERNAL_BACKEND` only works in debug builds; an installed app always starts its own backend.

## Where things are stored

| What        | Where                                                     |
| ----------- | --------------------------------------------------------- |
| Database    | `%APPDATA%\com.personalfinance.app\personal-finance.db`   |
| Backend log | `%LOCALAPPDATA%\com.personalfinance.app\logs\backend.log` |

The database and its backups are **encrypted** (AES-256, through SQLCipher). The file holds no
readable data, not even table names, so a copy of it, or of a backup, is useless without the key.

- **The key** is stored in the **Windows Credential Manager** for your Windows account, outside the data
  folder, and is handed to the app when it starts. The database key is derived from it; Plaid access
  tokens and the Plaid secret are encrypted with it as well (AES-256-GCM).
- **If the key is lost** (you reinstall Windows or move to a new computer), the database and every
  backup cannot be opened. Keep a copy of the **recovery key** (Data and backups -> Encryption -> Show
  recovery key) in a password manager. To use a backup on a new computer, restore it and enter the
  recovery key when asked; bank connections then have to be connected again.
- **Upgrading:** the first launch of this version encrypts an existing database and any earlier
  backups, checks the result against the original, and removes the unencrypted copy. If that check
  fails, your data is left exactly as it was.
- **Not covered:** the key lives in your Windows account, so software running as you could ask for it.
  Exports (CSV and JSON) and the backend log are ordinary files, by design.

## Syncing

When the app opens it syncs each connection in the background, unless that connection was synced
successfully within the last **30 minutes** (so reopening the app right away does not sync again).
The **Sync now** button in the sidebar always syncs immediately, and connecting a bank syncs it
straight away. Two settings control this, both in **Settings → Syncing**, and changes apply at once:

- _Minutes between syncs at launch_: the cooldown above (0 = sync on every launch).
- _Also sync while the app stays open, every N minutes_: off (0) by default.

Syncing works from wherever you left off, so after days or months away it simply catches up. If
you are offline, nothing breaks: the app keeps showing your last synced data and tries again next
time. Each complete paginated update is saved with its sync position in one database transaction,
so an interruption preserves the previous update and the next sync safely retries. Pending
transactions keep their edits, splits, and receipts when their posted replacements arrive on another page.

### What is kept from each transaction

Besides the date, amount, description, merchant, category and payment channel, the app keeps everything
else Plaid sends: the **time of day** (when the bank reports it), the bank's **original wording**, the
**location** (address, city, region, postal code, country, coordinates, store number), the **merchant**
(Plaid's merchant ID, merchant category code, logo address and website), the **payment details**
(method, processor, reference, reason, by order of, PPD ID), how **confident** Plaid is of the
category, and **every counterparty** with its type, website and confidence. Open a transaction and
expand **More from your bank** to see them. Banks send different amounts of this, so many rows show only
part of it. Logos are stored as addresses and are not loaded from the internet.

When a version adds fields like these, its first launch resets each connection's sync position, so the
next sync reads the full history again and fills them in. Transactions are matched by ID and updated in
place, so nothing is duplicated and your own edits, categories, and notes are kept.

## Categories, rules, and editing

The **Transactions** page lets you search, filter (account, category, pending or posted, dates),
sort, and change a category right in the row. Click a merchant to open its details, where you can
change the merchant name, category, recipient (for transfers such as Zelle), and notes. These edits
are stored separately from what your bank reports, so a later sync never overwrites them.

The **Categories** page holds your categories and **rules**. A rule says "if the merchant contains
this text, use this category". Rules are tried from the top and the first match wins. They categorize
new transactions automatically and never change a category you picked by hand. On the first run the
app creates a starting set of categories and rules based on your bank's own categories; all of it can
be edited, archived, or deleted.

On the **Accounts** page, each credit card has a **Credit limit history** where you can add, edit,
or delete limits by hand, including past changes. Changes the bank reports during a sync are added
automatically and labelled "observed from bank".

## Dashboard, calendar, and budgets

The **Dashboard** is made of widgets (net worth, balances, spending, budgets, a calendar, and more).
Press **Edit dashboard** to drag widgets around by their title bar, resize them from the bottom-right
corner, remove one with its **✕**, change a widget's settings, or add one with **+ Add widget**. Press
**Done** to save (or **Cancel** to throw the changes away); the layout is kept between launches. **Reset to default** restores the starting dashboard.

The **Calendar** page fills the window (the month grid grows and shrinks with it) and shows each
day's spending, income, and which accounts were active.

- **Pick any month or year** from the two dropdowns in the title, or step with the arrows.
- **Click a day** to see its total balance at the end of the day, the change in balance, money in and
  out, its transactions, a note, and what is expected. **Press on one day and drag to another** (or
  Shift+click) to see the same figures for the whole span: balance at the start and end, change, money
  in and out, spending and income (transfers left out), and top categories.
- **Debt payments are kept apart from spending.** A payment toward a credit card or loan shows as
  "Debt paid" (a blue ↓ line on the day) instead of money out, and the panel shows the debt owed and
  how it changed that day. A payment is counted once, from the card's side; if the card itself is not
  connected, the payment from the account that paid is used instead.
- **Notes:** write a note for any day; it is saved on this computer and shown as a mark on the grid.
- **Add transaction** (on the selected day, to an account you keep by hand) and **Add expected
  transaction**. An expected transaction can happen once or repeat daily, weekly (on chosen days),
  monthly (a day of the month, the last day, or such as the 2nd Tuesday), or yearly, every N of those,
  ending never, on a date, or after a number of times. Expected items show on the grid, feed the
  projected balance for future days, and can be recorded as a real transaction (hand-kept accounts),
  marked done, or skipped one date at a time.
- The balance is worked out from today's balance and the transactions the app has, for cash accounts
  and cards (investments are not included). It is only as complete as the history the app holds.

The **Budgets** page sets a monthly limit per category (a group's budget also counts its
subcategories), and "Copy from last month" carries them forward.

"Spending" and "income" are the same everywhere:

- **Money to or from other people counts.** A Zelle to a friend or rent to a landlord is spending; money
  a person sends you (a Zelle, a gift) is income.
- **Transfers between your own accounts do not count** (checking to savings, an ATM withdrawal to a
  cash wallet), and neither do credit-card payments, which would count the same money twice.
- The app finds own-account transfers by matching: an outgoing and an incoming transaction of exactly
  the same amount on two different accounts, within four days, where at least one reads like a transfer
  or payment. It re-checks after every sync and at launch. A transfer whose other side is not connected
  cannot be matched, so open it on the Transactions page and choose **Transfer between my own
  accounts: Yes**. You can also say **No** for a wrongly matched one, or **Let the app decide**.
- Refunds reduce spending, and pending transactions are included.
- A pending transaction entered by hand does not change the posted balance or its history. It
  still counts in spending and budgets for its date and in expected calendar amounts and forecasts.
  Outstanding entries dated today or earlier are projected on the next day; future entries use
  their own date. Pending card charges are included in the estimated upcoming bill. Mark an entry
  posted when it clears to move it from the projection into the balance.

### Adding your own widget

A widget is one file. Copy `frontend/src/widgets/TemplateWidget.example.tsx` to
`frontend/src/widgets/YourThingWidget.tsx` (the name must end in `Widget.tsx`), change the `id`,
title, and content, and it appears in **Add widget** with a settings dialog built from the settings
you declare. No lists, routes, or server code to edit. Details are in
`frontend/src/widgets/README.md`, and `npm test` checks every widget against the rules.
New widgets appear in the picker; they are not added to a dashboard you have already customized.

## Investments

The **Investments** page shows brokerage and retirement accounts: total value, allocation by asset
class, value over time, holdings, and activity. **Connect a brokerage** links one through Plaid (for
example Fidelity). For something Plaid cannot connect, such as the Thrift Savings Plan, use **Add
account by hand**, then **Edit holdings** (the TSP funds are built in), or **Import holdings (CSV)**.
Transactions can be added one at a time or imported from CSV. Importing the same file again never
creates duplicates.

CSV files need a header row. Holdings: `symbol` or `name`, `quantity`, `price` or `value`, and
optionally `cost_basis`, `asset_class`, `as_of`. Transactions: `date`, `type` (buy, sell, dividend,
interest, contribution, withdrawal, fee, transfer, other), `amount` (positive; the type sets the
direction), and optionally `symbol`, `quantity`, `price`, `fees`, `description`. The import dialog shows an
example.

A gain is shown only for holdings whose cost you recorded, and the page says how much it covers.
Value over time has a dot for each day it was recorded (each sync or manual update); nothing is
estimated in between. Four dashboard widgets (portfolio value, allocation, holdings, value over time)
can be added from **Edit dashboard → + Add widget**.

### Entering your own data

- **Transactions you type in:** **Transactions → Add transaction** records any payment or deposit by
  hand (date, amount, direction, merchant, category, recipient or sender, notes). Bank transactions
  stay read-only except for category, merchant, recipient/sender, and notes; hand-entered ones can be
  edited fully or deleted.
- **Cash and other accounts kept by hand:** **Accounts → Add account by hand** creates a Cash, checking,
  savings, or credit-card account. Its balance is worked out from its transactions (an optional opening
  balance is stored as a transfer so it never counts as spending).
- **Sender:** money that arrives (for example a Zelle payment) stores who sent it, next to the
  recipient on money that leaves. Both can be searched and edited, and a rule can match on sender.
- **Merchants → categories:** **Categories → Merchants** lists every merchant; choose a category and all
  its transactions, now and later, follow it. Spellings such as "Chipotle" and "CHIPOTLE 2041" count as
  one merchant. A category you chose on a single transaction is kept unless you tick the override box.
- **Full investment records:** holdings and activity keep everything the provider sends (identifiers,
  sector, vested amounts, price date, tax lots, subtype, and the raw record). Click a holding's name or an
  activity row's **Details** to see it. Hand-entered accounts such as the TSP accept the same fields.
- **Hide or show an account:** each account on the Accounts tab has a **Hide** button (and **Show** to bring
  it back). A hidden account is left out of balances, net worth, debt, spending and income, charts, the
  calendar, the transactions list and its pickers, merchants, and recurring charges. It keeps syncing
  and stays in your exports, so showing it again restores everything with nothing missing. A
  transfer between a visible and a hidden account is still recognized as a transfer.
- Migrations take an automatic **pre-update backup** of the database before they run.

### Thrift Savings Plan (by hand)

**Add TSP account** creates a manual account with a split between the TSP funds (shares must total exactly 100%). On the account you can set **recurring contributions** (weekly, every 2 weeks, twice a month, monthly). Each time one comes due, the app divides the dollar amount by the split and buys units at that day's fund price (rounded to 4 decimals), recording a contribution and updating the holdings. Due contributions are applied at launch and hourly; anything without a price yet waits and is applied once prices exist.

Fund prices: **Fetch prices** downloads from the Max TSP API (api.maxtsp.com, no key needed) or from tsp.gov (which refused scripted downloads with a 403 in testing; the app does not try to get around that). Choose how far back to go: the last month, 3 months, a year, 5 years, since the day you got the funds, or everything (back to 2003); every day in that range is saved. You can also **Import price file** (CSV from tsp.gov) or **Add a price** by hand. Prices you type are never overwritten by a download.

**Past activity:** import the _Investment Activity Detail_ CSV from tsp.gov to record your real contributions (yours, plus the agency's automatic and matching amounts) with the units and unit price of each day. The prices also fill the fund price table, and re-importing is safe. The option to add the units to the holdings is off by default, so history is not counted twice if you already entered today's holdings. The _chart_ CSV (one fund's price history) imports through **Import price file**.

### Income, credits, and refunds

Each category can say how money coming in under it counts: **income** (taxable; it counts in income totals, the month report, and the sandbox's income figures), a **refund** (it only lowers spending and never counts as income, even when it comes from a person), or the usual rules. Transfers has two subcategories set up this way: **Credit** (counts as taxable income) and **Refund** (not income, not taxable). Change the setting in a category's Edit dialog; the category list shows it.

On the Transactions page, tags (Pending, Paid / Paid from, Moved to / from, Entered by hand) sit in their own Tags column to the right of the amount, and the table uses the page's full width so amounts are never cut off.

### Planning, reports, and review

- **Planning → Cash-flow forecast:** today's bank balances (checking, savings, cash) projected 30–180 days ahead from expected transactions on the calendar, recurring money in and out of those accounts, and card bills. Shows the lowest point and warns when it goes below zero.
- **Planning → Card bills:** set each card's statement closing day and due day (plus an optional minimum and autopay). The app works out the latest statement balance, what has been paid toward it, what is left, and the status (paid, partly paid, due, overdue). An estimate: interest, fees and pending charges can make the bank's figure differ.
- **Planning → Subscriptions:** recurring charges with their yearly cost, price increases, and ones that seem to have stopped; mark each keep / cancel / cancelled (flags a charge that continues after you cancelled).
- **Month report:** income, spending, savings rate, net worth change, debt paid, cashback, budgets, spending by category against the month before, and the largest purchases.
- **Review:** transactions from the last 60 days worth a look (no category, new merchant, unusual or large amount, possible duplicate) until marked reviewed; and possible duplicates (same account and amount within 3 days, usually one entered by hand and one from the bank) to delete or dismiss.
- **Receipts and files:** attach pictures, PDFs, or text files (up to 10 MB) to a transaction from its details. They are stored inside the encrypted database and included in backups; the JSON export lists them without their contents.

### Sandbox

The Sandbox page has two modes.

**Maths nodes:** add nodes from the list (income, expenses, your real average income or spending, numbers, add / subtract / multiply / divide, percent-of, per-period, federal income tax, Social Security & Medicare, state income tax, county / city income tax, Virginia vehicle tax, result), drag a node by its title, and drag from an output (right) to an input (left) to wire them; several wires into one input are added. Money is yearly. Drag the background to pan, scroll to zoom, select a wire or node and press Delete to remove it, double-click a title to rename. A wire that would make a loop is refused. The **Take-home pay example** shows pay → 401(k)/TSP → taxes → take-home per year, month, and paycheck.

**Cash-flow map (experimental):** inspired by a money-flow sandbox: buckets (income, tax, pre-tax, spending, savings, bucket) with money flowing between them. Drag a bucket's colored dot onto another bucket to send money there, and click a flow to set its amount per year, month, two weeks, or week. Flows run from the center of one bucket to the center of the other (beneath the buckets, so they come out wherever the buckets face each other), and are shaded from the source bucket's color to the target's. Select a bucket to show its ✕ (removes it) and the grip in its bottom-left corner (makes it wider or taller, never smaller than the default); click its name to rename it. Moving and resizing snap to the dotted grid. Drag a flow away and drop it on empty space to delete it, or drop it on another bucket to send it there instead. A tax bucket can be federal, state (MD, DC, VA), Maryland county, FICA (Social Security and Medicare), FERS, Virginia car tax, or a custom tax charged as a percentage, a fixed yearly amount, or your own brackets. Flows into taxes work themselves out (after pre-tax deductions; a health plan or HSA through payroll is also free of Social Security and Medicare, a 401(k)/TSP is not), and a **Bucket** collects the remainder of each bucket flowing into it (what that bucket has not sent elsewhere), adding several sources together; a source feeding several buckets shares its remainder between them. Flows animate in the direction money moves and are thicker for more money; a bucket sending out more than it has is flagged. The side panel shows where the money goes and projects savings growth at each account's rate. Saved automatically.

**Saving and loading maps:** both modes save what is on screen automatically. **Save or load…** also keeps named copies (for example "Plan A" and "Plan B") to switch between: save what is on screen under a name, then load, rename, or delete saved copies. Once a copy is loaded or saved, **Save** updates it. Each mode has its own list, and a copy can also be downloaded as a file and loaded from one. Saved copies live in the encrypted database (and its backups and JSON export).

**Taxes (Maryland, DC, Virginia, tax year 2026):** federal brackets and standard deductions from IRS Rev. Proc. 2025-32; Maryland state brackets (with the new 6.25% and 6.5% top rates) and all 23 counties plus Baltimore City from the Comptroller of Maryland's 2026 withholding memo (Feb. 4, 2026; Allegany rose to 3.2% and Kent to 3.3%; Anne Arundel brackets and Frederick's income tiers included); Maryland's deduction and exemption, DC, and Virginia from the Tax Foundation's 2026 state table. Virginia's yearly vehicle (personal property) tax: Fairfax County ($4.57 per $100, 49% state relief on the first $20,000, nothing at $1,000 or less; from the county), Prince William County ($3.50, 37%), and Loudoun County ($3.09 for 2026; its relief percentage was not confirmed, so enter it), or your own rate, relief, and yearly fees. DC and Virginia have no local income tax; Maryland and DC have no yearly car tax. Every tax node also takes your own flat rate or your own brackets (typed as "from percent" pairs, such as 0 2, 3000 3, 17000 5.75), and the state node takes your own standard deduction. **2027** figures had not been published, so 2027 uses the 2026 figures and says so. Tax figures are for planning, not filing: credits, phase-outs (such as Maryland's exemption at higher incomes), and special cases are left out.

### Cashback

On a credit card (Accounts page) set a default rate plus rates for specific categories. The card's **Cashback** section shows what qualifying purchases earned for a period (refunds subtract; transfers, card payments, fees and interest are excluded). A Cashback dashboard widget is available (off by default).

**Online rates.** Tick **Online only** on a rate for cards that pay more online (for example 3% online on Bank of America's Customized Cash Rewards). An online purchase earns the higher of its online rate and its ordinary rate. Whether a purchase was online is your call if you made one, else Plaid's payment channel (`online` / `in store` / `other`, a guess that is sometimes wrong). Each transaction shows an **Online purchase** field with the bank's answer and a **Bought online** setting to change it; a change is marked "set by you" (✎), is kept across syncs, and can be reset to the bank's answer. The transaction list has an Online filter and an Online badge.

### Also in this release

- Starter **Gas** and **Streaming** categories with rules; past matching, non-manually-categorised transactions are moved into them.
- Transfers between your own accounts no longer count toward money in / money out (calendar cells and period summary).
- Adding a transaction can repeat **weekly, every 2 weeks, or monthly**.
- Calendar: a day with notes shows an editable notes box; click away to save and deselect.
- Search (Ctrl+K, or the sidebar's Search button): pages, accounts, categories, and transactions by merchant, note, people, category, or an exact amount ("54.11"). Choosing a transaction opens it on the Transactions page, highlighted.
- Split transactions: divide one transaction across categories (from its edit window, "Split across categories..."). Totals, budgets, and charts count each part in its own category; the bank's record does not change. If the bank later changes the amount, the transaction counts whole again until the parts add up.
- Paychecks (Planning > Paychecks): regular pay found in your income (every week, every two weeks, twice a month, or monthly), with the next payday and what it adds up to this year. The Taxes page uses it for the year's pay. Interest and dividends are not counted as pay.
- What changed recently (Planning > Subscriptions): recent price changes, newly started recurring charges, and charges after you marked one cancelled, with what each adds or saves a year.
- Goals: save toward a target, by a date or not. Link the accounts the money is in (their balance counts) and add money kept elsewhere; it shows the progress and what a month gets you there.
- Retirement projection (Investments > a TSP account): where the balance might be by retirement with your recurring contributions and the employer match, at 4%, 6%, and 8% growth, also in today's dollars and as a rough yearly amount to spend.
- Syncing: each connection syncs at most once every 5 minutes, however the sync is started (the Sync button says when it can sync again).
- Data & backups: buttons open the data folder (the database) and the backups folder in File Explorer, and "Clear diagnostics" clears the recorded sync problems.
- Transactions: click a row to select it, double-click to edit (or click the merchant). Edit windows close with Escape or a click outside, and ask first when there are unsaved changes. Clicking a transaction in the Network graph opens it here, on whichever page it is, flashing its row.
- Categories: Insurance (Auto, Home & Renters, Life, Health), Taxes (with Tax Refund, which lowers spending and is never income), Phone & Internet under Rent & Utilities, Subscriptions (with Streaming), Gifts & Donations, Transportation subcategories (Gas, Parking & Tolls, Public Transit, Rideshare, Car Maintenance, Car Payment), Income subcategories (Paycheck, Interest & Dividends, Side Income, Reimbursements as a refund), and Cash Withdrawals and Savings & Investing under Transfers. A category can be set to "Moving my own money": its transactions count as transfers (never income or spending), unless you choose otherwise for one, and a match with your other account still wins.
- Network (sidebar): a graph of institutions, their accounts, and the transactions of a period (a day, a week, 30 or 90 days, a year, or custom dates; filters and layout stay when the period changes), after Obsidian's graph view. Accounts link to spending grouped by category, with subcategories as their own nodes under their category (Food & Drink, then Groceries); "Group categories across accounts" makes one node per category for all accounts; income sources (diamonds) link to the account paid into; transfers between your own accounts are dashed lines with an arrow, flowing from the account the money left toward the one it went to (money moved both ways shows as two lines side by side, one per direction). Hover to highlight connections, drag nodes, scroll to zoom; zooming in on a group (or double-clicking it) shows its transactions one by one. Payments to and from other people (Zelle and the like) link the account with a node for each person (orange squares), the arrow pointing the way the money went (the "Transfers to and from people" filter; off, they show as spending). A settings panel has search, filters (income, spending, category grouping, transfers, people, idle accounts: turn off spending and income to see only transfers between accounts), and the forces.
- Gift cards and store credit: an account kept by hand (Accounts → Add account by hand → Gift card / store credit) that holds dollar credits with one business. Credits are not real dollars: nothing on these accounts counts toward income, spending, budgets, taxes, forecasts, or reports (the credit left does count in net worth, as other assets), and they stay out of the Transactions list and transfer matching. They only show in the account's own figures (choose the account in a filter to see them). "Use credits" records a purchase paid with credits alone, or with the rest from a hand-kept account (added there, where it counts as usual) or a connected card (left to the bank's sync).
- Collections: accounts kept by hand (Accounts → Add account by hand), opened with "Open collection". Two types:
  - **Pokémon cards**: each card has its TCGplayer id (required when adding one; the number in its tcgplayer.com/product/ link, or paste the link) and a condition (NM, LP, MP, HP, DMG; Lightly Played by default; the same card in two conditions is two items). Pasting a TCGplayer export imports cards as LP and looks up their TCGplayer ids by set code and number from tcgcsv.com (free, no key). "Market prices" gets prices from JustTCG with your own API key (stored encrypted, never shown or exported): cards are priced 20 per request, at their condition, at most once a day, with the price history the plan allows (7 days on the free plan; every fetch is kept, so the history grows). The free plan allows 100 requests a day and 1,000 a month; runs show their cost first, stop at either limit, and carry on next time. A market price fills the card's value unless you typed one in. "Clear prices" undoes price lookups (keeping ids and typed values). Click a market price for its history; sort the table by any column.
  - **Other collection**: items valued by hand, no ids, conditions, or prices.
    The account is worth quantity × value summed (items without a value count as nothing yet), recorded in its balance history and counted in net worth as other assets. "Export to file" saves a collection (items, ids, conditions, prices, and their history, never the API key) and "Import collection file" (Accounts, under accounts kept by hand) makes it a new account in another copy of the app, with nothing to look up again.
- TSP: import the price chart download (`chart.csv`: a date range and fund name as the header, then one price a day) and the Investment Activity Detail file. Together they bring the holdings up to date and rebuild the account's daily balance history for the net worth chart. Contributions can be one-time as well as recurring, and can include employer money: the federal (FERS) 1% automatic plus up-to-4% match, or a custom match (x% of what you put in, up to y% of pay, plus z% of pay). Employer money is recorded as its own activity. Past balances are rebuilt at launch, each new day, and after contributions are applied.
- Taxes: finds the year's income and Transfers > Credit transactions, grouped by source. For each source you can enter its annual income, pre-tax 401(k)/TSP and health/HSA/FSA amounts, and whether it is exempt from FICA. Add your filing status, state (MD, DC or VA), Maryland county, any other local rate and what was withheld, and it estimates federal tax, FICA, and state and local taxes. Answers are saved per year.
- Calendar: on the chosen day, click the empty dashed box to type a note right in it (Enter or clicking away saves; it then shows as a white bar). Clicking a transaction in the side panel opens a table of the selected days' transactions, with expected ones listed first.

## Insights and multiple dashboards

**Insights** shows patterns in your own data. _Recurring charges and deposits_ lists subscriptions,
rent, bills, and paychecks the app has noticed repeating at steady intervals, what each costs per
month, when the next one is expected, whether one seems to have stopped, and whether its price went
up. If something is not really recurring, press **Not recurring** and it is hidden (you can show it
again). _Credit utilization_ shows how much of each card's limit is in use and how that has changed;
under 30% is the figure usually suggested. Both are also available as dashboard widgets.

The dashboard can have several **named dashboards** (tabs next to the title). **New dashboard**
creates one, optionally as a copy of the current one; **Rename** and **Delete** are there too.
Each has its own widgets, and the one you last used is the one shown next time.

## Net worth history, backups, and exports

**Net worth over time** (in the sidebar, and as a dashboard widget) shows your net worth at the end of each
**day, week, or month**, over 1 month, 3 months, 12 months, or everything. Pick the step with the Day /
Week / Month buttons; the table beneath lists each period with its change, assets, and debts, and says
how each figure was known.

- Each account's balance comes from the balances the app recorded (each sync or manual update).
- Between and before those, a **cash account or card is rebuilt from its transactions**, working back
  or forward from the nearest recorded balance: a deposit account's balance is the later balance plus
  what left it since; a card's debt is the later debt minus what was added to it since. So the chart has
  history from your first transaction, not only from the day you connected.
- **Investments and loans** keep their last recorded balance until the next one.
- Before an account's first transaction or record, it is **held at the balance it started with**, so
  net worth does not jump the day it first appears. That is an assumption, because what it was earlier
  is not known; hiding an account removes it from the chart.
- A daily view shows at most the latest 1,000 days; weekly and monthly go further back. The rebuilt
  part is only as complete as the transaction history the app has.

**Data & backups** is where your data is protected:

- The app makes an automatic backup when it opens (at most about twice a day; turn it off or change
  how many are kept on the page). **Back up now** makes one whenever you like.
- **Restore** replaces your data with a backup the next time the app opens: choose it, then close and
  reopen the app. The data it replaces is saved as a backup first, so a restore can itself be undone.
- **Export** writes your transactions, accounts, and investments as CSV files (they open in Excel), or
  everything as one JSON file, into the exports folder. Connection keys and Plaid credentials are never
  included.
- **Health and diagnostics** checks that the database is sound and explains any recent sync failure
  with a next step. "Copy report" gives text with counts and codes only, safe to paste when asking for
  help.

Backups and exports live in your data folder (`%APPDATA%com.personalfinance.app`). They do not
contain the key that protects your bank connections, which stays in Windows Credential Manager: if
Windows is reinstalled, restore your data from a backup and reconnect each bank.

## Developing against your real accounts

Link your real accounts once, in the **installed app**. The development copy can then **borrow** those
connections and read the same accounts, without linking again and without touching the real ones.

1. In the real app, open Data and backups and choose **Back up now**, and keep your **recovery key**
   (Data and backups, then Encryption, then Show recovery key) where you can copy it.
2. In a normal PowerShell window (not inside another tool, since it asks for the key without showing
   it), run `npm run dev:borrow`. It reads the newest backup of the real app (or pass
   `--backup <file>`), lists what it would borrow, and asks before doing anything. Use
   `--dry-run` to only look. It borrows Production connections by default (`--environment sandbox`
   for Sandbox ones).
3. In the dev app, open Settings and choose **Production**, then Accounts and **Sync now**.

What it does and does not do:

- **The real app is never changed.** The backup is read through a private temporary copy, nothing is
  written beside the real files, and the command refuses to run against the real app's data folder.
- **A borrowed connection is read-only.** It is marked _Borrowed_, and disconnecting, signing in
  again, or repairing it is refused in the dev copy (those have to be done in the real app), because
  the access token is shared and disconnecting it here would disconnect it there too. "Remove from
  this copy" only deletes the dev copy's record and never tells Plaid. It syncs only when you press
  **Sync now**, not at launch or on a timer, so restarting the dev server never calls the bank.
- **Each copy keeps its own sync position,** so the two never interfere. Plaid does not count a second
  user of the same connection as another connection.
- **Your Plaid keys come along.** An access token only works with the keys it was issued under, so the
  Production client ID and secret are copied into the dev copy too (kept encrypted under the dev key).
  If the dev copy already has its own keys for that environment they are kept, unless you pass
  `--replace-credentials`.
- **Re-authentication stays in the real app.** If the bank asks you to sign in again, do it there; the
  token does not change, so the dev copy works again at its next sync.

Be aware that the dev copy then holds a working bank access token and your real transactions, and
that its key is an ordinary file next to its database (`data/dev-encryption.key`). Keep the `data`
folder out of any synced or shared location and delete it when you are done. The protection against
changing the real connection is in this app's code; anyone with the token could still call Plaid directly.

## Plaid and demo mode

The app starts in **Demo** mode: the Connect button offers made-up banks, so everything can be tried
with no Plaid account. In Settings, "Data source" switches to **Plaid Sandbox** or **Production**,
where you enter your Plaid client ID and secret (stored encrypted, never shown again). Each data
source keeps its own connections. Demo and Plaid Sandbox have been verified end to end (connecting a bank and a brokerage, syncing, and repairing an expired login); Production has not been tried yet.

## Security notes

- The backend listens on `127.0.0.1` only.
- Every `/api` request needs the random token that Tauri creates at each launch. The Tauri window
  gets it automatically; "Open in browser" in Settings passes it once through a link and the
  backend swaps it for an HttpOnly cookie.
- Requests with an unexpected `Host` or `Origin` header are rejected, which blocks DNS-rebinding
  and cross-site requests from web pages.
- Secrets (`.env`, databases, backups, logs) are in `.gitignore`.
