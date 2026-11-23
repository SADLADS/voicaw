package com.voicaw.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** The login the app keeps for the page (ApiLogin), as the desktop app's (electron/apiLogin.js). */
public class ApiLoginTest {
    private static String token(String sid) {
        String claims = "{\"id\":1,\"username\":\"a\",\"sid\":\"" + sid + "\",\"iat\":5}";
        return "eyJhbGciOiJIUzI1NiJ9." + Base64.getUrlEncoder().withoutPadding().encodeToString(claims.getBytes(StandardCharsets.UTF_8)) + ".sig";
    }

    @Test
    public void theApiAddressComesFromTheBuildAndMustBeHttps() {
        assertEquals("https://app.voicaw.com/api/", ApiLogin.prefixOf("https://app.voicaw.com/api/"));
        assertEquals("https://app.voicaw.com/api/", ApiLogin.prefixOf("https://app.voicaw.com/api"));
        assertNull(ApiLogin.prefixOf("http://app.voicaw.com/api/"));
        assertNull(ApiLogin.prefixOf("https://user@app.voicaw.com/api/"));
        assertNull(ApiLogin.prefixOf("not a url"));
    }

    @Test
    public void onlyRequestsToThatAddressAreMade() {
        String api = "https://app.voicaw.com/api/";
        assertTrue(ApiLogin.isApi(api, "https://app.voicaw.com/api/profile"));
        assertFalse(ApiLogin.isApi(api, "https://app.voicaw.com/apix/profile"));
        assertFalse(ApiLogin.isApi(api, "https://app.voicaw.com.evil.example/api/profile"));
        assertFalse(ApiLogin.isApi(api, "https://evil.example/api/"));
        assertFalse(ApiLogin.isApi(api, "https://app.voicaw.com/api/x\\y"));
        assertFalse(ApiLogin.isApi(null, "https://app.voicaw.com/api/profile"));
    }

    @Test
    public void readsTheSessionAToken() {
        assertEquals("S1", ApiLogin.sidOf(token("S1")));
        assertNull(ApiLogin.sidOf("nonsense"));
        assertNull(ApiLogin.sidOf(null));
    }

    @Test
    public void findsTheLoginCookieInAnAnswer() {
        assertEquals("abc.def.ghi", ApiLogin.cookieValue("voicaw_session=abc.def.ghi; Path=/api; Max-Age=2592000; HttpOnly; Secure; SameSite=None"));
        assertEquals("", ApiLogin.cookieValue("voicaw_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=None"));
        assertNull(ApiLogin.cookieValue("other=1; Path=/"));
        assertNull(ApiLogin.cookieValue(null));
    }

    @Test
    public void aLoginIsAlwaysTaken() {
        String fresh = token("NEW");
        assertEquals(fresh, ApiLogin.nextToken(fresh, null, null));
        assertEquals(fresh, ApiLogin.nextToken(fresh, null, token("OLD")));
    }

    @Test
    public void aRenewalOrLogoutOnlyForTheSessionSavedNow() {
        String saved = token("S1");
        String renewed = token("S1") + "x";
        assertEquals(renewed, ApiLogin.nextToken(renewed, "S1", saved));
        assertEquals("", ApiLogin.nextToken("", "S1", saved));
        // An older session's answer arriving late leaves the newer login alone.
        assertNull(ApiLogin.nextToken("", "OLD", saved));
        assertNull(ApiLogin.nextToken(renewed, "OLD", saved));
        assertNull(ApiLogin.nextToken("", "S1", null));
    }

    @Test
    public void aMalformedCookieIsNeverSaved() {
        assertNull(ApiLogin.nextToken("a b", null, null));
        assertNull(ApiLogin.nextToken(null, null, null));
    }
}
