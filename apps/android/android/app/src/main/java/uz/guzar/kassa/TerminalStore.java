package uz.guzar.kassa;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * The paired terminal's credentials. The terminal key is a secret: it is stored encrypted with an
 * AES-GCM key that lives in the Android Keystore (never exported), and never reaches JavaScript.
 */
final class TerminalStore {
    static final class Config {
        final String terminalId;
        final String terminalKey;
        final String terminalName;
        final String hubHost;
        final int hubPort;
        final String fingerprint256;
        final long pairedAtMs;

        Config(String terminalId, String terminalKey, String terminalName, String hubHost, int hubPort, String fingerprint256, long pairedAtMs) {
            this.terminalId = terminalId;
            this.terminalKey = terminalKey;
            this.terminalName = terminalName;
            this.hubHost = hubHost;
            this.hubPort = hubPort;
            this.fingerprint256 = fingerprint256;
            this.pairedAtMs = pairedAtMs;
        }
    }

    private static final String PREFS = "mezon_terminal";
    private static final String FIELD = "config";
    private static final String KEY_ALIAS = "mezon_terminal_store_v1";
    private static final int IV_BYTES = 12;

    private final SharedPreferences prefs;
    private Config cached;
    private boolean loaded;

    TerminalStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized Config read() {
        if (loaded) return cached;
        loaded = true;
        String sealed = prefs.getString(FIELD, null);
        if (sealed == null) return cached = null;
        try {
            JSONObject o = new JSONObject(open(sealed));
            cached = new Config(
                o.getString("terminalId"),
                o.getString("terminalKey"),
                o.getString("terminalName"),
                o.getString("hubHost"),
                o.getInt("hubPort"),
                o.getString("fingerprint256"),
                o.getLong("pairedAtMs")
            );
        } catch (Exception e) {
            // Keystore key lost (e.g. restored onto another phone): the device must pair again.
            prefs.edit().remove(FIELD).apply();
            cached = null;
        }
        return cached;
    }

    synchronized void write(Config c) throws Exception {
        JSONObject o = new JSONObject();
        o.put("terminalId", c.terminalId);
        o.put("terminalKey", c.terminalKey);
        o.put("terminalName", c.terminalName);
        o.put("hubHost", c.hubHost);
        o.put("hubPort", c.hubPort);
        o.put("fingerprint256", c.fingerprint256);
        o.put("pairedAtMs", c.pairedAtMs);
        if (!prefs.edit().putString(FIELD, seal(o.toString())).commit()) {
            throw new IllegalStateException("Could not save terminal credentials");
        }
        cached = c;
        loaded = true;
    }

    synchronized void clear() {
        prefs.edit().remove(FIELD).commit();
        cached = null;
        loaded = true;
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private static String seal(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private static String open(String sealed) throws Exception {
        byte[] raw = Base64.decode(sealed, Base64.NO_WRAP);
        if (raw.length <= IV_BYTES) throw new IllegalStateException("corrupt");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, raw, 0, IV_BYTES));
        return new String(c.doFinal(raw, IV_BYTES, raw.length - IV_BYTES), StandardCharsets.UTF_8);
    }
}
