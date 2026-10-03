package com.voicaw.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/** The app: the web client in Capacitor's WebView, with VoicawPlugin as its bridge. */
public class MainActivity extends BridgeActivity {
    private static int resumed;

    /** Whether the app is on screen (notifications are silent then: the page plays its sounds). */
    static boolean isInForeground() {
        return resumed > 0;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoicawPlugin.class);
        super.onCreate(savedInstanceState);
        // Back goes back in the app (its routes are history entries); from the first page it
        // leaves the app running, as Android's Home would, rather than closing it.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) webView.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed++;
    }

    @Override
    public void onPause() {
        resumed--;
        super.onPause();
    }
}
