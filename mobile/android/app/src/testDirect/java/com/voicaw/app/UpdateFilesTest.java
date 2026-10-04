package com.voicaw.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/** The checks AppUpdater makes on releases.json and the APK it downloads. */
public class UpdateFilesTest {
    private static final byte[] DATA = "voicaw".getBytes(StandardCharsets.UTF_8);
    // What publish-android.mjs writes for it: createHash('sha256').update('voicaw').digest('hex')
    private static final String DATA_SHA256 = "170cf93a43479ba390a0fdb2d49330ff335f6f449efb0aa11d9ab250656a395a";

    @Test
    public void acceptsOnlyThePublishedApkNames() {
        assertTrue(UpdateFiles.isApkName("voicaw-0.1.4.apk"));
        assertTrue(UpdateFiles.isApkName("voicaw-12.99.99.apk"));
        assertFalse(UpdateFiles.isApkName("voicaw.apk"));
        assertFalse(UpdateFiles.isApkName("../voicaw-0.1.4.apk"));
        assertFalse(UpdateFiles.isApkName("voicaw-0.1.4.apk/x"));
        assertFalse(UpdateFiles.isApkName("https://elsewhere/voicaw-0.1.4.apk"));
        assertFalse(UpdateFiles.isApkName(null));
    }

    @Test
    public void updatesOnlyToAHigherVersion() {
        assertTrue(UpdateFiles.isNewer(105, 104));
        assertFalse(UpdateFiles.isNewer(104, 104));
        assertFalse(UpdateFiles.isNewer(103, 104));
    }

    @Test
    public void copiesAndHashes() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        List<Long> progress = new ArrayList<>();
        String hash = UpdateFiles.copyChecked(new ByteArrayInputStream(DATA), out, DATA.length, (received, total) -> progress.add(received));
        assertEquals(DATA_SHA256, hash);
        assertEquals("voicaw", out.toString("UTF-8"));
        assertEquals(Long.valueOf(DATA.length), progress.get(progress.size() - 1));
    }

    @Test
    public void refusesADownloadOfTheWrongSize() {
        assertThrows(Exception.class, () -> UpdateFiles.copyChecked(new ByteArrayInputStream(DATA), new ByteArrayOutputStream(), DATA.length - 1, null));
        assertThrows(Exception.class, () -> UpdateFiles.copyChecked(new ByteArrayInputStream(DATA), new ByteArrayOutputStream(), DATA.length + 1, null));
    }

    @Test
    public void writesHexLikeReleasesJson() {
        assertEquals("00ff10", UpdateFiles.hex(new byte[] { 0, (byte) 0xff, 0x10 }));
    }
}
