# Finance Viewer (Android)

A read-only phone view of Personal Finance. The Windows app writes an encrypted snapshot for each
paired phone after every sync (see "Phone viewer" in [DEVELOPING.md](../DEVELOPING.md)); this app
reads it from Google Drive and shows it. It has no internet permission and never holds a Plaid key,
a bank token or the recovery key.

## How it works

- `src/lib/snapshot.ts` opens the snapshot with WebCrypto (AES-256-GCM) and `DecompressionStream`.
  Its tests use the PC's own writer (`backend/src/services/viewer.service.ts`), so the two cannot
  drift apart unnoticed.
- `src/lib/session.ts` runs pairing, picking the file, unlocking and loading, falling back to the
  last good copy kept on the phone when the file cannot be read.
- `android/app/src/main/java/com/personalfinance/viewer/ViewerNativePlugin.java` does what a page
  cannot: scans the QR code (Google's code scanner, no camera permission), keeps the snapshot key
  wrapped by an Android Keystore key that needs the fingerprint, face or screen lock each time
  (that prompt is the app lock), and reads the picked file with lasting access.
- The app needs Android 11 or later and a screen lock.

## Building

The APK is built on GitHub (the **Android** workflow) on every push that changes `mobile/`, and
attached to each draft release by the Release workflow. Locally, with Android Studio installed:

```
npm run sync -w mobile          # build the web part and copy it into android/
cd mobile/android && ./gradlew assembleRelease
```

`npm run dev -w mobile` serves the web part in a browser, with stand-ins for the phone's features
(paste the pairing code as text, pick the .snap file from disk).

## Signing

Android installs a new version over an old one only when both are signed with the same key. Make
one key, once, and keep it with the updater key:

```
keytool -genkeypair -v -keystore finance-viewer.keystore -alias viewer -keyalg RSA -keysize 4096 -validity 36500
```

Then add these repository secrets: `ANDROID_KEYSTORE_BASE64` (the file, base64), and
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Until then each build is
signed with a throwaway key: installing a newer one means uninstalling the old one and pairing
again.
