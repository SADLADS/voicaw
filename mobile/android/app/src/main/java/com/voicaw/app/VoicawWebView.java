package com.voicaw.app;

import android.content.Context;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

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
