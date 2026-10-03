package com.voicaw.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

/** Opens what server/fcm.js `sealPayload` makes (the vector below came from it). */
public class PushCryptoTest {
    private static final String KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    private static final String SEALED =
        "dKP3rlRRIJMrUM+FeORgUbqWdIoODPdWnvTWJu3tC/x+PGOKBKgGrhA1HlPBO+tV2X9yFb3zhjIDtrJylysdLwI3GOdgHkHKN0YpFUY5yH/L";

    @Test
    public void opensWhatTheServerSealed() throws Exception {
        assertEquals("{\"type\":\"dm\",\"title\":\"Sam ✓\",\"ciphertext\":\"v1.abc\"}", PushCrypto.open(KEY, SEALED));
    }

    @Test
    public void refusesAnotherKey() {
        String other = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=";
        assertThrows(Exception.class, () -> PushCrypto.open(other, SEALED));
    }

    @Test
    public void refusesATamperedPush() {
        String tampered = (SEALED.charAt(20) == 'A' ? "B" : "A");
        String sealed = SEALED.substring(0, 20) + tampered + SEALED.substring(21);
        assertThrows(Exception.class, () -> PushCrypto.open(KEY, sealed));
    }
}
