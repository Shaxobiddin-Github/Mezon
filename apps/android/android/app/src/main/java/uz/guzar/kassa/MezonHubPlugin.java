package uz.guzar.kassa;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import javax.net.ssl.SSLException;
import org.json.JSONObject;

/**
 * T4.4: the phone as a v1 LAN terminal. JavaScript sees only {@code info/pair/leave/request};
 * the terminal key stays here (see {@link TerminalStore}) and is added to every forwarded request,
 * exactly like the desktop terminal proxy ({@code apps/desktop/src/terminal/terminal-proxy.ts}).
 */
@CapacitorPlugin(name = "MezonHub")
public class MezonHubPlugin extends Plugin {
    private static final String TERMINAL_AUTH_HEADER = "x-mezon-terminal";
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.\\-:\\[\\]]{1,253}$");
    private static final Pattern PATH = Pattern.compile("^/(?!/)[\\x21-\\x7e]*$");
    private static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE");
    private static final Set<String> DROPPED_HEADERS = Set.of(
        "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length",
        "origin", "referer", "cookie"
    );
    private static final int MAX_BODY_CHARS = 2 * 1024 * 1024;

    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private TerminalStore store;

    @Override
    public void load() {
        store = new TerminalStore(getContext());
    }

    @PluginMethod
    public void info(PluginCall call) {
        TerminalStore.Config c = store.read();
        JSObject o = new JSObject();
        if (c == null) {
            o.put("mode", "hub");
        } else {
            o.put("mode", "terminal");
            o.put("terminalName", c.terminalName);
            o.put("hubHost", c.hubHost);
            o.put("hubPort", c.hubPort);
            o.put("fingerprint256", c.fingerprint256);
            o.put("pairedAtMs", c.pairedAtMs);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void pair(PluginCall call) {
        String host = call.getString("host", "").trim();
        Integer port = call.getInt("port");
        String code = LanTls.normalizePairingCode(call.getString("code", ""));
        String name = call.getString("terminalName", "").trim();
        if (!HOST.matcher(host).matches() || port == null || port < 1 || port > 65535 || code.isEmpty() || name.isEmpty() || name.length() > 60) {
            call.resolve(failure("INVALID_INPUT"));
            return;
        }
        if (store.read() != null) {
            call.resolve(failure("ALREADY_TERMINAL"));
            return;
        }
        pool.execute(() -> {
            String fingerprint;
            try {
                fingerprint = LanTls.probeFingerprint(host, port);
            } catch (IOException e) {
                call.resolve(failure("HUB_UNREACHABLE"));
                return;
            }
            try {
                String nonce = LanTls.newNonce();
                JSONObject body = new JSONObject();
                body.put("terminalName", name);
                body.put("nonce", nonce);
                body.put("proof", LanTls.pairingProof(code, "terminal", fingerprint, nonce));
                Map<String, String> headers = new HashMap<>();
                headers.put("content-type", "application/json");
                // Pinned already: if the certificate changed since the probe, nothing is sent.
                LanTls.HubResponse res = LanTls.pinnedRequest(host, port, fingerprint, "POST", "/lan/pair", headers, body.toString(), 10);
                if (res.status != 200) {
                    call.resolve(failure("PAIRING_REJECTED"));
                    return;
                }
                JSONObject out = new JSONObject(res.body);
                String expected = LanTls.pairingProof(code, "hub", fingerprint, nonce);
                if (!LanTls.constantTimeEquals(out.getString("hubProof"), expected)) {
                    call.resolve(failure("PAIRING_REJECTED"));
                    return;
                }
                store.write(
                    new TerminalStore.Config(
                        out.getString("terminalId"),
                        out.getString("terminalKey"),
                        name,
                        host,
                        port,
                        fingerprint,
                        System.currentTimeMillis()
                    )
                );
                JSObject ok = new JSObject();
                ok.put("ok", true);
                ok.put("fingerprint256", fingerprint);
                call.resolve(ok);
            } catch (SSLException e) {
                call.resolve(failure("PAIRING_REJECTED"));
            } catch (IOException e) {
                call.resolve(failure("HUB_UNREACHABLE"));
            } catch (Exception e) {
                call.resolve(failure("PAIRING_REJECTED"));
            }
        });
    }

    @PluginMethod
    public void leave(PluginCall call) {
        store.clear();
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
    }

    @PluginMethod
    public void request(PluginCall call) {
        TerminalStore.Config c = store.read();
        if (c == null) {
            call.reject("This device is not a paired terminal", "TERMINAL_NOT_PAIRED");
            return;
        }
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        String path = call.getString("path", "");
        String body = call.getString("body", null);
        if (!METHODS.contains(method) || !PATH.matcher(path).matches()) {
            call.reject("Invalid hub request", "INVALID_REQUEST");
            return;
        }
        if (body != null && body.length() > MAX_BODY_CHARS) {
            call.reject("Request body too large", "BODY_TOO_LARGE");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        JSObject in = call.getObject("headers", new JSObject());
        for (Iterator<String> it = in.keys(); it.hasNext(); ) {
            String original = it.next();
            String k = original.toLowerCase(Locale.ROOT);
            if (DROPPED_HEADERS.contains(k) || k.startsWith("x-mezon-")) continue;
            String v = in.optString(original, null);
            if (v != null) headers.put(k, v);
        }
        headers.put(TERMINAL_AUTH_HEADER, c.terminalId + "." + c.terminalKey);
        final String finalBody = body;
        pool.execute(() -> {
            try {
                LanTls.HubResponse res = LanTls.pinnedRequest(c.hubHost, c.hubPort, c.fingerprint256, method, path, headers, finalBody, 10);
                JSObject outHeaders = new JSObject();
                for (Map.Entry<String, List<String>> h : res.headers.entrySet()) {
                    if (h.getKey() == null) continue;
                    outHeaders.put(h.getKey().toLowerCase(Locale.ROOT), String.join(", ", h.getValue()));
                }
                JSObject o = new JSObject();
                o.put("status", res.status);
                o.put("headers", outHeaders);
                o.put("body", res.body);
                call.resolve(o);
            } catch (SSLException e) {
                call.reject("Hub certificate does not match the paired kassa", "LAN_PIN_MISMATCH");
            } catch (IOException e) {
                call.reject("Hub is unreachable", "HUB_UNREACHABLE");
            }
        });
    }

    /** Like the desktop "relaunch": the POS starts again from scratch in the new mode. */
    @PluginMethod
    public void restart(PluginCall call) {
        android.app.Activity activity = getActivity();
        android.content.Intent intent = activity.getPackageManager().getLaunchIntentForPackage(activity.getPackageName());
        if (intent == null) {
            call.reject("No launch intent", "RESTART_FAILED");
            return;
        }
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK);
        call.resolve();
        // A fresh task: a new WebView and bridge, so every plugin (and the POS) starts again.
        // Done while the app is in the foreground; Android blocks relaunching from the background.
        activity.runOnUiThread(() -> activity.startActivity(intent));
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }

    private static JSObject failure(String code) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("code", code);
        return o;
    }
}
