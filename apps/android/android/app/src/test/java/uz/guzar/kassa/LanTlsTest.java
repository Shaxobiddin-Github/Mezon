package uz.guzar.kassa;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Base64;
import org.junit.Test;

/**
 * Oracle: the expected values come from the hub's own TypeScript code
 * (packages/drivers/src/node: generateSelfSignedTlsMaterial, X509Certificate.fingerprint256 and
 * lanPairingProof). If the phone formats the fingerprint or the HMAC message differently, the hub
 * rejects pairing, so these must match byte for byte.
 */
public class LanTlsTest {
    private static final String HUB_CERT_DER_B64 =
        "MIIBIzCByqADAgECAhA3VZdhABa5CAd8sMQi/ECXMAoGCCqGSM49BAMCMBQxEjAQBgNVBAMMCW1lem9uLWh1YjAeFw0yNTEyMzEyMzAwMDBaFw0zNTEyMzAwMDAwMDBaMBQxEjAQBgNVBAMMCW1lem9uLWh1YjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAxGuniqcUcE3Axt5dihNpIPCRVuqiQfi+Ko8yuE3sEVUD/rFtNaeJXmyJqEjjVjMsKXzJbL+AxafmLsmBMViG0wCgYIKoZIzj0EAwIDSAAwRQIgaCVSxivqzEBFwuoHWWJWZp9xcCDxLHeBaG63ecGdPD0CIQDi5yFACk7qBrL7JLqXIBmhz8ozSioUS2DndqjyHV2QTQ==";
    private static final String HUB_FINGERPRINT =
        "56:DA:92:66:9B:B4:C6:5E:5B:5E:12:D8:79:8C:D7:AE:7D:4C:B7:F9:2C:E1:02:BC:FD:88:9E:75:B6:CC:17:C7";

    @Test
    public void fingerprintMatchesNodeFormat() throws Exception {
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
            .generateCertificate(new ByteArrayInputStream(Base64.getDecoder().decode(HUB_CERT_DER_B64)));
        assertEquals(HUB_FINGERPRINT, LanTls.fingerprint256(cert));
    }

    @Test
    public void pairingProofMatchesHub() {
        String fp = "AB:CD:01:23:45:67:89:EF:AB:CD:01:23:45:67:89:EF:AB:CD:01:23:45:67:89:EF:AB:CD:01:23:45:67:89:EF";
        // Lower-case fingerprint and a dashed, lower-case code normalize to the same proof.
        assertEquals(
            "480f921610aca9f9076a2f38bdd13f062b8657f8dd71f703ac1c666615dfdd9c",
            LanTls.pairingProof("abcde-12345", "terminal", fp.toLowerCase(), "nonce_ABCDEFGHIJKLMN")
        );
        assertEquals(
            "b5a0d11bc3e1e83173c22a60f1936bbfeab15f4066ea1fa8e13447d3d16dda0b",
            LanTls.pairingProof("ABCDE12345", "hub", fp, "nonce_ABCDEFGHIJKLMN")
        );
    }

    @Test
    public void rolesAreNotInterchangeable() {
        String a = LanTls.pairingProof("ABCDE12345", "terminal", HUB_FINGERPRINT, "nonce_ABCDEFGHIJKLMN");
        String b = LanTls.pairingProof("ABCDE12345", "hub", HUB_FINGERPRINT, "nonce_ABCDEFGHIJKLMN");
        assertFalse(LanTls.constantTimeEquals(a, b));
        assertTrue(LanTls.constantTimeEquals(a, a));
    }
}
