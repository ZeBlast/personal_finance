# Personal Finance

A personal finance app for Windows that keeps everything on your own computer. See where your money
goes, plan bills and budgets, track goals, debts and investments, and keep your bank accounts up to
date automatically. Your data is stored encrypted on your computer and is never sent to anyone
else's server.

## Install

1. Open the [latest release](https://github.com/ZeBlast/personal_finance/releases/latest).
2. Under **Assets**, download `Personal Finance_x.y.z_x64-setup.exe`.
3. Run it. It installs for your Windows user only, so it does not ask for an administrator
   password.

If Windows shows **"Windows protected your PC"**, choose **More info**, then **Run anyway**. Windows
shows this for apps from smaller publishers that are not yet code-signed.

You need Windows 10 or 11 (64-bit). Nothing else to install.

## First steps

When the app opens, a welcome page offers three ways to start:

- **Connect my banks**: balances and transactions update on their own. This needs a free Plaid
  account; if you don't have one yet, see [Connecting your banks](#connecting-your-banks) first.
- **Import or type them in**: no bank connection needed. Download a CSV of transactions from your
  bank's website and import it, or keep an account by hand, such as cash.
- **Look around first**: loads made-up sample banks so you can see how everything works. A violet
  banner reminds you while sample data is on; switch to your real accounts in Settings.

Then follow the short checklist on the welcome page. The most important step is the next one.

## Save your recovery key

Your data is encrypted with a key that Windows keeps for your user account, so the app opens
without a password. **If you reinstall Windows or move to a new computer, that key is gone, and
only your recovery key can open your data and backups.**

Go to **Settings > Data & backups > Show recovery key**, store it in a password manager (or on
paper, somewhere safe), and click **I saved it somewhere safe**.

## Connecting your banks

The app connects to banks through [Plaid](https://plaid.com), the service behind many finance
apps. Plaid needs a free account of your own; the app then talks to Plaid directly from your
computer.

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com/signup).
2. In Plaid's dashboard, request access to real banks ("Production") for personal use. Approval
   can take a few days.
3. Under **Developers > Keys**, copy your **client ID** and **Production secret**.
4. In the app, open **Settings**, choose **My real banks**, paste the two keys and save. They are
   stored encrypted on your computer.
5. Open **Accounts** and choose **Connect an account**.

## Updating

Open **Settings > Updates > Check for updates**. The app downloads the new version from this
project's GitHub releases, checks that it is signed by this project, and restarts. You can also
download the newer installer and run it; it replaces the app and keeps your data. Your data is backed up automatically before a new version
first runs.

## Where your data lives

| What                      | Where                                                     |
| ------------------------- | --------------------------------------------------------- |
| Your data (encrypted)     | `%APPDATA%\com.personalfinance.app\personal-finance.db`   |
| Backups (encrypted)       | `%APPDATA%\com.personalfinance.app\backups`               |
| Logs, for troubleshooting | `%LOCALAPPDATA%\com.personalfinance.app\logs\backend.log` |

**Settings > Data & backups** makes backups, restores them, and exports your data as files you can
open in a spreadsheet.

## Uninstall

Use **Settings > Apps** in Windows. Your data folder is kept, so reinstalling picks up where you
left off; delete the folder above if you want it gone too.

## Building it yourself

See [DEVELOPING.md](DEVELOPING.md).
