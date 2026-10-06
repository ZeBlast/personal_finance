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

The database is **not encrypted**. Anyone who can read your Windows user folder can read it. Keep
backups somewhere private. Plaid access tokens and the Plaid secret are encrypted separately (AES-256-GCM)
with a key stored in the **Windows Credential Manager**, not in the data folder. If that key is
lost (for example after reinstalling Windows), the saved tokens cannot be read and each bank has to
be connected again.

## Syncing

When the app opens it syncs each connection in the background, unless that connection was synced
successfully within the last **30 minutes** (so reopening the app right away does not sync again).
The **Sync now** button in the sidebar always syncs immediately, and connecting a bank syncs it
straight away. Two settings control this, both in **Settings → Syncing**, and changes apply at once:

- _Minutes between syncs at launch_: the cooldown above (0 = sync on every launch).
- _Also sync while the app stays open, every N minutes_: off (0) by default.

Syncing works from wherever you left off, so after days or months away it simply catches up. If
you are offline, nothing breaks: the app keeps showing your last synced data and tries again next
time. Each sync is saved page by page, so an interruption never leaves half-written data.

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
Press **Customize** to drag widgets by their title bar, resize them from the bottom-right corner,
change a widget's settings, hide or remove it, or add one from **Add widget**. Press **Done** to save;
the layout is kept between launches. **Reset to default** restores the starting dashboard.

The **Calendar** page shows each day's transactions and which account they were on; click a day for
its list. The **Budgets** page sets a monthly limit per category (a group's budget also counts its
subcategories), and "Copy from last month" carries them forward.

"Spending" is the same everywhere: transfers and credit-card payments are left out, refunds reduce
it, and pending transactions are included.

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
can be added from **Customize → Add widget**.

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

**Net worth history** (in the sidebar, and as a dashboard widget) is built only from balances the app
actually recorded. Because the app is not always open, it can have gaps; they are drawn dashed and
listed, never filled in with guesses.

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
