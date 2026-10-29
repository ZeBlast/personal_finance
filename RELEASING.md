# Releasing a new version

Releases are built on GitHub, not on your computer: GitHub Actions builds the Windows installer,
signs the update, and makes a draft release. You check it and publish it.

## One-time setup

1. **Repository visibility.** Downloads and in-app updates come from GitHub Releases, which only
   people who can see the repository can reach. For anyone to install the app, the repository must
   be public (or the releases hosted somewhere public).
2. **The updater signing key.** Installed apps only accept updates signed with this project's key.
   The key pair was made with `npx tauri signer generate`:
   - The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
   - The private key is at `%USERPROFILE%\.tauri\personal-finance-updater.key`. **Never commit it.**
     Add its contents as a repository secret named `TAURI_SIGNING_PRIVATE_KEY` (GitHub: Settings >
     Secrets and variables > Actions > New repository secret). Keep a copy in your password
     manager: if it is lost, installed copies can no longer be updated and would need reinstalling
     by hand.

## Each release

1. `node scripts/set-version.mjs 0.2.0` (sets the version in every file that has one).
2. Commit, push, then push a tag: `git tag v0.2.0` and `git push origin v0.2.0`.
   (Or run the **Release** workflow by hand from the Actions tab.)
3. When the workflow finishes, open the draft release on GitHub, add what changed, and publish.

Installed apps find it under **Settings > Updates**. The CI workflow runs the type check, lint and
tests on every push to `master`, and the release workflow runs them again before building.

## Code signing (optional, recommended)

An unsigned installer makes Windows show "Windows protected your PC" until enough people have run
it. Signing removes that. The options:

- **Azure Trusted Signing** (about $10 a month): Microsoft's service, recognized by SmartScreen
  right away. Needs an Azure account and an identity check.
- **SignPath Foundation** (free for open-source projects): signs releases built by GitHub Actions
  for public, open-source repositories.
- **A code-signing certificate** from a certificate authority (from about $200 a year).

Each needs an account in your name, so it cannot be set up from the code alone. Once you have one,
add the signing step to `.github/workflows/release.yml` (Tauri documents each option under
"Windows code signing") and store its credentials as repository secrets.
