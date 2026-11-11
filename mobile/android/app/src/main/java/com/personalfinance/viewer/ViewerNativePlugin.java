package com.personalfinance.viewer;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The phone's side of the viewer. Kept small on purpose: everything about the data (the snapshot
 * format, decryption, the screens) is in the web part; this only does what a web page cannot.
 *
 * - scanCode: Google's code scanner (it runs in Play services, so the app needs no camera access).
 * - saveKey / unlockKey: the PC's snapshot key, wrapped by an AES key in the Android Keystore that
 *   can only be used right after the fingerprint, face or screen lock. That prompt is the app lock.
 * - pickFile / readFile: the snapshot file in Google Drive, through Android's file picker, with
 *   lasting read access.
 * - writeCache / readCache: the last good snapshot in the app's private storage (still encrypted).
 *
 * The app has no internet permission: nothing here, or in the web part, can send data anywhere.
 */
@CapacitorPlugin(name = "ViewerNative")
public class ViewerNativePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String WRAP_ALIAS = "pf-viewer-wrap";
    private static final String PREFS = "pf-viewer";
    private static final String PREF_DEVICE = "deviceId";
    private static final String PREF_WRAPPED = "wrapped";
    private static final String PREF_IV = "iv";
    private static final String CACHE_FILE = "snapshot.snap";
    private static final long MAX_FILE_BYTES = 64L * 1024 * 1024;
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------------------------------------
    // Scanning the pairing code

    @PluginMethod
    public void scanCode(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner
            .startScan()
            .addOnSuccessListener(barcode -> {
                JSObject result = new JSObject();
                result.put("text", barcode.getRawValue());
                call.resolve(result);
            })
            .addOnCanceledListener(() -> call.reject("cancelled"))
            .addOnFailureListener(e -> call.reject("The code scanner is not available: " + e.getMessage()));
    }

    // ------------------------------------------------------------------------------------------
    // The key

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = prefs();
        boolean paired = p.contains(PREF_WRAPPED);
        JSObject result = new JSObject();
        result.put("paired", paired);
        result.put("deviceId", paired ? p.getString(PREF_DEVICE, null) : null);
        call.resolve(result);
    }

    @PluginMethod
    public void saveKey(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String key = call.getString("key");
        if (deviceId == null || key == null) {
            call.reject("deviceId and key are required");
            return;
        }
        byte[] raw;
        try {
            raw = Base64.decode(key, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            call.reject("That pairing code's key is not readable.");
            return;
        }
        if (raw.length != 32) {
            call.reject("That pairing code's key is not 32 bytes.");
            return;
        }
        if (!deviceSecure()) {
            call.reject("Set a screen lock (PIN, pattern, password or fingerprint) on this phone first, then pair again.");
            return;
        }
        Cipher cipher;
        try {
            SecretKey wrapKey = newWrapKey();
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, wrapKey);
        } catch (Exception e) {
            call.reject("Could not make a key on this phone: " + e.getMessage());
            return;
        }
        authenticate(call, cipher, "Protect the viewer's key", unlocked -> {
            try {
                byte[] wrapped = unlocked.doFinal(raw);
                prefs()
                    .edit()
                    .putString(PREF_DEVICE, deviceId)
                    .putString(PREF_WRAPPED, Base64.encodeToString(wrapped, Base64.NO_WRAP))
                    .putString(PREF_IV, Base64.encodeToString(unlocked.getIV(), Base64.NO_WRAP))
                    .apply();
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not keep the key: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void unlockKey(PluginCall call) {
        SharedPreferences p = prefs();
        String wrapped = p.getString(PREF_WRAPPED, null);
        String iv = p.getString(PREF_IV, null);
        String deviceId = p.getString(PREF_DEVICE, null);
        if (wrapped == null || iv == null || deviceId == null) {
            call.reject("This phone is not paired.");
            return;
        }
        Cipher cipher;
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            SecretKey wrapKey = (SecretKey) store.getKey(WRAP_ALIAS, null);
            if (wrapKey == null) {
                call.reject("The key is gone from this phone. Pair again.");
                return;
            }
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrapKey, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        } catch (KeyPermanentlyInvalidatedException e) {
            call.reject("The phone's screen lock changed, so the key can no longer be used. Pair again.");
            return;
        } catch (Exception e) {
            call.reject("Could not open the key: " + e.getMessage());
            return;
        }
        authenticate(call, cipher, "Unlock Finance Viewer", unlocked -> {
            try {
                byte[] raw = unlocked.doFinal(Base64.decode(wrapped, Base64.NO_WRAP));
                JSObject result = new JSObject();
                result.put("deviceId", deviceId);
                result.put("key", Base64.encodeToString(raw, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP));
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not open the key: " + e.getMessage());
            }
        });
    }

    private boolean deviceSecure() {
        KeyguardManager keyguard = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    /** A new wrapping key, usable only right after the fingerprint, face or screen lock. */
    private SecretKey newWrapKey() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(WRAP_ALIAS)) store.deleteEntry(WRAP_ALIAS);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
                // Adding a fingerprint later should not lock the user out of their own viewer.
                .setInvalidatedByBiometricEnrollment(false)
                .build()
        );
        return generator.generateKey();
    }

    private interface Unlocked {
        void run(Cipher cipher);
    }

    /** Shows the system prompt; on success hands over the cipher it unlocked. */
    private void authenticate(PluginCall call, Cipher cipher, String title, Unlocked then) {
        Activity activity = getActivity();
        if (!(activity instanceof FragmentActivity)) {
            call.reject("The unlock prompt is not available.");
            return;
        }
        FragmentActivity fragmentActivity = (FragmentActivity) activity;
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                fragmentActivity,
                ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                        if (crypto == null || crypto.getCipher() == null) {
                            call.reject("The unlock did not unlock the key.");
                            return;
                        }
                        then.run(crypto.getCipher());
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence message) {
                        boolean userCancelled =
                            code == BiometricPrompt.ERROR_USER_CANCELED ||
                            code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                            code == BiometricPrompt.ERROR_CANCELED;
                        call.reject(userCancelled ? "cancelled" : message.toString());
                    }
                }
            );
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    // ------------------------------------------------------------------------------------------
    // The snapshot file

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = data.getData();
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            // Some places cannot grant lasting access; the file then has to be picked again later.
        }
        JSObject out = new JSObject();
        out.put("uri", uri.toString());
        out.put("name", displayName(resolver, uri));
        call.resolve(out);
    }

    private String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null) return name;
            }
        } catch (Exception e) {
            // Fall back to the address below.
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "snapshot";
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("uri is required");
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
            if (in == null) {
                call.reject("The file could not be opened.");
                return;
            }
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(readAll(in), Base64.NO_WRAP));
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("Access to the file was lost. Pick it again.");
        } catch (Exception e) {
            call.reject("The file could not be read: " + e.getMessage());
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buffer)) != -1) {
            total += n;
            if (total > MAX_FILE_BYTES) throw new IOException("the file is too large");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    // ------------------------------------------------------------------------------------------
    // The last good copy

    private File cacheFile() {
        return new File(getContext().getFilesDir(), CACHE_FILE);
    }

    @PluginMethod
    public void writeCache(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required");
            return;
        }
        File target = cacheFile();
        File temp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(Base64.decode(data, Base64.NO_WRAP));
        } catch (Exception e) {
            call.reject("Could not keep a copy: " + e.getMessage());
            return;
        }
        if (!temp.renameTo(target)) {
            temp.delete();
            call.reject("Could not keep a copy.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void readCache(PluginCall call) {
        JSObject result = new JSObject();
        File file = cacheFile();
        if (!file.exists()) {
            result.put("data", org.json.JSONObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            result.put("data", Base64.encodeToString(Files.readAllBytes(file.toPath()), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the kept copy: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------------------------------
    // Forgetting

    @PluginMethod
    public void forget(PluginCall call) {
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            if (store.containsAlias(WRAP_ALIAS)) store.deleteEntry(WRAP_ALIAS);
        } catch (Exception e) {
            // The preferences below are cleared either way, so the key is unusable.
        }
        prefs().edit().clear().apply();
        cacheFile().delete();
        ContentResolver resolver = getContext().getContentResolver();
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            try {
                resolver.releasePersistableUriPermission(permission.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException e) {
                // Already gone.
            }
        }
        call.resolve();
    }
}
