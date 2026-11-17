package com.voicaw.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.text.InputType;

import org.junit.Test;

/** Which boxes tell the keyboard they take GIFs and stickers (VoicawWebView.takesImages). */
public class VoicawWebViewTest {
    @Test
    public void multiLineTextTakesImages() {
        assertTrue(VoicawWebView.takesImages(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        assertTrue(VoicawWebView.takesImages(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES | InputType.TYPE_TEXT_FLAG_AUTO_CORRECT));
    }

    @Test
    public void oneLineAndOtherBoxesDont() {
        assertFalse(VoicawWebView.takesImages(InputType.TYPE_CLASS_TEXT));
        assertFalse(VoicawWebView.takesImages(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD));
        assertFalse(VoicawWebView.takesImages(InputType.TYPE_CLASS_NUMBER));
        assertFalse(VoicawWebView.takesImages(InputType.TYPE_NULL));
    }
}
