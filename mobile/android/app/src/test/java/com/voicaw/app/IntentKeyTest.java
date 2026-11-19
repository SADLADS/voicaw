package com.voicaw.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Only the app's own intents are acted on (IntentKey.same). */
public class IntentKeyTest {
    @Test
    public void takesOnlyTheKey() {
        assertTrue(IntentKey.same("abc123", "abc123"));
        assertFalse(IntentKey.same("abc123", "abc124"));
        assertFalse(IntentKey.same("abc123", "abc12"));
        assertFalse(IntentKey.same("abc123", ""));
    }

    @Test
    public void neverAMissingOne() {
        assertFalse(IntentKey.same("abc123", null));
        assertFalse(IntentKey.same(null, null));
        assertFalse(IntentKey.same(null, "abc123"));
    }
}
