package uz.guzar.kassa;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * T4.1/T4.4 LAN transport for the phone terminal, the Java twin of
 * {@code packages/drivers/src/node/pinned-https.ts}:
 * the hub's self-signed certificate is trusted only by its SHA-256 fingerprint (LAN IPs change,
 * so the pin is the identity, not the host name), and pairing proofs are HMACs bound to the
 * fingerprint seen on the wire, so a man in the middle cannot obtain a terminal key.
 */
final class LanTls {
    private LanTls() {}

    static final class HubResponse {
        final int status;
        final Map<String, java.util.List<String>> headers;
        final String body;

        HubResponse(int status, Map<String, java.util.List<String>> headers, String body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }
    }

    /** Node's {@code cert.fingerprint256} format: upper-case hex pairs joined by ':'. */
    static String fingerprint256(X509Certificate cert) throws CertificateEncodingException {
        byte[] digest = sha256(cert.getEncoded());
        StringBuilder sb = new StringBuilder(digest.length * 3);
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format(Locale.ROOT, "%02X", digest[i] & 0xff));
        }
        return sb.toString();
    }

    static String normalizePairingCode(String code) {
        return code.replaceAll("[\\s-]", "").toUpperCase(Locale.ROOT);
    }

    /** {@code HMAC-SHA256(key=normalized code, "mezon.lan.pair.v1|role|FINGERPRINT|nonce")} in hex. */
    static String pairingProof(String code, String role, String fingerprint256, String nonce) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(normalizePairingCode(code).getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String message = "mezon.lan.pair.v1|" + role + "|" + fingerprint256.toUpperCase(Locale.ROOT) + "|" + nonce;
            byte[] out = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", e);
        }
    }

    static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    static String newNonce() {
        byte[] raw = new byte[24];
        new SecureRandom().nextBytes(raw);
        return android.util.Base64.encodeToString(raw, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }

    /** First contact: read the certificate the hub presents. No secret is sent on this request. */
    static String probeFingerprint(String host, int port) throws IOException {
        AtomicReference<X509Certificate> seen = new AtomicReference<>();
        X509TrustManager capture = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client certificates are not used");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
                seen.set(chain[0]);
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        try (Response res = client(capture, 8).newCall(new Request.Builder().url(url(host, port, "/lan/hello")).get().build()).execute()) {
            ResponseBody body = res.body();
            if (body != null) body.close();
        }
        X509Certificate cert = seen.get();
        if (cert == null) throw new IOException("Hub presented no certificate");
        try {
            return fingerprint256(cert);
        } catch (CertificateEncodingException e) {
            throw new IOException("Unreadable hub certificate", e);
        }
    }

    /** Every later request: the handshake fails before any byte is sent if the pin does not match. */
    static HubResponse pinnedRequest(String host, int port, String expectedFingerprint, String method, String path, Map<String, String> headers, String body, int timeoutSeconds)
        throws IOException {
        Request.Builder rb = new Request.Builder().url(url(host, port, path));
        for (Map.Entry<String, String> h : headers.entrySet()) rb.header(h.getKey(), h.getValue());
        RequestBody requestBody = null;
        if (body != null) {
            String type = headers.getOrDefault("content-type", "application/json");
            requestBody = RequestBody.create(body.getBytes(StandardCharsets.UTF_8), MediaType.parse(type));
        } else if ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) {
            requestBody = RequestBody.create(new byte[0], null);
        }
        rb.method(method, requestBody);
        OkHttpClient client = pinnedClient(expectedFingerprint, timeoutSeconds);
        Request request = rb.build();
        try {
            return execute(client, request);
        } catch (javax.net.ssl.SSLException e) {
            throw e;
        } catch (IOException e) {
            // A pooled connection the hub already closed fails at once. Drop the pool; a read
            // (GET) is safe to send again, a write is not (the hub may have applied it).
            client.connectionPool().evictAll();
            if (!"GET".equals(method)) throw e;
            return execute(client, request);
        }
    }

    private static HubResponse execute(OkHttpClient client, Request request) throws IOException {
        try (Response res = client.newCall(request).execute()) {
            ResponseBody rbody = res.body();
            String text = rbody == null ? "" : rbody.string();
            return new HubResponse(res.code(), res.headers().toMultimap(), text);
        }
    }

    private static final Map<String, OkHttpClient> PINNED = new java.util.concurrent.ConcurrentHashMap<>();

    private static OkHttpClient pinnedClient(String expectedFingerprint, int timeoutSeconds) {
        String expected = expectedFingerprint.toUpperCase(Locale.ROOT);
        return PINNED.computeIfAbsent(expected + "|" + timeoutSeconds, k -> client(new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("client certificates are not used");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
                if (!constantTimeEquals(fingerprint256(chain[0]), expected)) {
                    throw new CertificateException("Hub certificate does not match the paired fingerprint");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }, timeoutSeconds));
    }

    private static OkHttpClient client(X509TrustManager trust, int timeoutSeconds) {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] { trust }, new SecureRandom());
            return new OkHttpClient.Builder()
                .sslSocketFactory(ctx.getSocketFactory(), trust)
                // The certificate pin above is the identity; host names/IPs on a LAN change.
                .hostnameVerifier((hostname, session) -> true)
                .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .readTimeout(Math.max(timeoutSeconds, 30), TimeUnit.SECONDS)
                .writeTimeout(Math.max(timeoutSeconds, 30), TimeUnit.SECONDS)
                // Idle connections are dropped well before the hub closes them.
                .connectionPool(new okhttp3.ConnectionPool(4, 4, TimeUnit.SECONDS))
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .build();
        } catch (Exception e) {
            throw new IllegalStateException("TLS unavailable", e);
        }
    }

    private static String url(String host, int port, String path) {
        String h = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        return "https://" + h + ":" + port + path;
    }

    private static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
