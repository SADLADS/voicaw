package com.voicaw.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** The app's own copy of the login cookie (LoginCookie): reading, writing and its life. */
public class LoginCookieTest {
    @Test
    public void findsTheLoginCookieAmongOthers() {
        assertEquals("aaa.bbb.ccc", LoginCookie.valueIn("voicaw_session=aaa.bbb.ccc"));
        assertEquals("a-b_c.d", LoginCookie.valueIn("other=1; voicaw_session=a-b_c.d; more=2"));
    }

    @Test
    public void noneWhenItIsMissingOrMalformed() {
        assertNull(LoginCookie.valueIn(null));
        assertNull(LoginCookie.valueIn(""));
        assertNull(LoginCookie.valueIn("other=1"));
        assertNull(LoginCookie.valueIn("voicaw_session="));
        assertNull(LoginCookie.valueIn("voicaw_session=a b"));
        assertNull(LoginCookie.valueIn("not_voicaw_session=abc"));
    }

    @Test
    public void putsItBackAsTheServerSetsIt() {
        assertEquals("voicaw_session=abc; Path=/api; Max-Age=100; HttpOnly; Secure; SameSite=None",
            LoginCookie.cookieLine("abc", 100));
    }

    @Test
    public void lastsThirtyDaysFromItsLastValue() {
        long saved = 1_000_000_000L;
        assertEquals(LoginCookie.LIFE_SECONDS, LoginCookie.secondsLeft(saved, saved));
        assertEquals(LoginCookie.LIFE_SECONDS - 3600, LoginCookie.secondsLeft(saved, saved + 3_600_000L));
        assertEquals(-1, LoginCookie.secondsLeft(saved, saved + (LoginCookie.LIFE_SECONDS + 1) * 1000));
    }
}
