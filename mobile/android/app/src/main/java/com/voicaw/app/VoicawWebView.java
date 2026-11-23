package com.voicaw.app;

import android.content.Context;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.CookieManager;

import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;

import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView (res/layout/capacitor_bridge_layout_main.xml puts it in place of
 * Capacitor's own), telling the keyboard that the page's multi-line text boxes (the message box,
 * documents) take pictures, so its GIF and sticker buttons work: a WebView says nothing of the
 * kind, so keyboards grey them out. What the keyboard sends is handed to the page (KeyboardContent).
 */
public class VoicawWebView extends CapacitorWebView {
    /**
     * What keyboards may send. "image/*" covers the rest; the named ones are for keyboards that
     * look for a type by name rather than matching it.
     */
    static final String[] IMAGE_TYPES = { "image/gif", "image/png", "image/webp", "image/jpeg", "image/*" };

    public VoicawWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        // The login is an HttpOnly cookie set by the API, which is cross-site to the page
        // (https://localhost), and a WebView only takes such cookies when told to. Told here,
        // before Capacitor loads the page: told after (MainActivity.onCreate, android-v1.3.1), a
        // cold start's first request (the saved login's /profile) could go without the cookie and
        // the app opened on the login screen, though the login was still good.
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true);
        // And the WebView doesn't keep that cookie across a restart: the app's own copy goes back
        // in, still before the page loads (LoginCookie).
        LoginCookie.restore(context);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        if (connection == null || !takesImages(outAttrs.inputType)) return connection;
        EditorInfoCompat.setContentMimeTypes(outAttrs, IMAGE_TYPES);
        return InputConnectionCompat.createWrapper(connection, outAttrs,
            (info, flags, opts) -> KeyboardContent.received(getContext(), info, flags));
    }

    /**
     * Whether the focused box can take a picture: the WebView marks contenteditable elements
     * and textareas multi-line, and one-line boxes (search, names, passwords) aren't. The page
     * still decides (a textarea doesn't take one: it says so).
     */
    static boolean takesImages(int inputType) {
        return (inputType & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT
            && (inputType & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
    }
}
