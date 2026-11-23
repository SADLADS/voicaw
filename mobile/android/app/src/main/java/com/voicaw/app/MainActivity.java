package com.voicaw.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/** The app: the web client in Capacitor's WebView, with VoicawPlugin as its bridge. */
public class MainActivity extends BridgeActivity {
    private static int resumed;

    // What the page last asked for behind the status and navigation bars (VoicawPlugin
    // `setSystemBars`), or null before it has.
    private Integer barColor;
    private boolean lightBars;

    /** Whether the app is on screen (notifications are silent then: the page plays its sounds). */
    static boolean isInForeground() {
        return resumed > 0;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoicawPlugin.class);
        super.onCreate(savedInstanceState);
        keepClearOfSystemBars();
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

    /**
     * The page never goes under the status bar, the navigation bar, a camera cutout or the
     * keyboard, on every Android version: the window is laid out edge to edge (Android 15+ always
     * does that to apps targeting it), the app pads itself clear of all of them, and the WebView
     * is told of none. Not Capacitor's SystemBars handling (insetsHandling "disable" in
     * capacitor.config.json): with a recent WebView it draws the page under the bars, leaving the
     * page to pad itself with env(safe-area-inset-*), and what the page is told while the
     * keyboard is up depends on the WebView's version.
     */
    private void keepClearOfSystemBars() {
        EdgeToEdge.enable(this);
        int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
            Insets around = insets.getInsets(bars);
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            // The keyboard's inset counts from the bottom of the screen, navigation bar included.
            view.setPadding(around.left, around.top, around.right, Math.max(around.bottom, keyboard.bottom));
            // Zeroed rather than consumed: a WebView handed CONSUMED stops updating its insets
            // (https://issues.chromium.org/issues/461332423).
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(bars | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
    }

    /** The colour behind the status and navigation bars (the page's), and whether it's light. */
    void setSystemBars(int color, boolean light) {
        barColor = color;
        lightBars = light;
        applySystemBars();
    }

    private void applySystemBars() {
        if (barColor == null) return;
        Window window = getWindow();
        View decor = window.getDecorView();
        decor.setBackgroundColor(barColor);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        controller.setAppearanceLightStatusBars(lightBars);
        controller.setAppearanceLightNavigationBars(lightBars);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Capacitor's SystemBars puts the system theme's back on every change, a rotation too.
        applySystemBars();
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
