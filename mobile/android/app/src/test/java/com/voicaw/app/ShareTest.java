package com.voicaw.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Which shared files the app agrees to read (Share.allowed). */
public class ShareTest {
    private static final String APP = "com.voicaw.app";

    @Test
    public void readsOtherAppsContent() {
        assertTrue(Share.allowed("content", "media", APP));
        assertTrue(Share.allowed("content", "com.google.android.apps.photos.contentprovider", APP));
        // Only a prefix of ours with a dot is ours.
        assertTrue(Share.allowed("content", "com.voicaw.application", APP));
    }

    @Test
    public void refusesItsOwnFiles() {
        assertFalse(Share.allowed("content", APP + ".fileprovider", APP));
        assertFalse(Share.allowed("content", APP, APP));
    }

    @Test
    public void refusesFilePathsAndOddUris() {
        assertFalse(Share.allowed("file", "", APP));
        assertFalse(Share.allowed("file", null, APP));
        assertFalse(Share.allowed("content", null, APP));
        assertFalse(Share.allowed("https", "example.com", APP));
        assertFalse(Share.allowed(null, "media", APP));
    }
}
