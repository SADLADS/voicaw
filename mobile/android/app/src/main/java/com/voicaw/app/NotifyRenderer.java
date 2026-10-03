package com.voicaw.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * The app's hidden page (client/notify.html, src/android/notifyPage.js) in an invisible WebView,
 * for when a push arrives: it words the notification exactly as the web app's service worker
 * does, decrypting DM and group previews with the keys the app keeps in its page storage (same
 * origin, https://localhost, so the same storage as the app), and declines calls with the
 * app's login. Nothing about the keys or the end-to-end encryption is done again here.
 *
 * Kept for a minute after its last use, so a burst of messages loads it once.
 */
final class NotifyRenderer {
    private static final String TAG = "VoicawNotify";
    private static final String PAGE = "https://localhost/notify.html";
    private static final long KEEP_MS = 60_000;

    private static NotifyRenderer instance;

    static synchronized NotifyRenderer get(Context context) {
        if (instance == null) instance = new NotifyRenderer(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    // Main thread only:
    private WebView webView;
    private boolean ready;
    private final List<Runnable> waiting = new ArrayList<>();
    private final Map<Integer, CompletableFuture<JSONObject>> pending = new HashMap<>();
    private int nextId;
    private final Runnable destroy = this::destroyNow;

    private NotifyRenderer(Context context) {
        this.context = context;
    }

    /**
     * Sends `request` ({ type: "render", payload } or { type: "decline", callId }) to the page
     * and waits for its answer: null if it failed or took longer than `timeoutMs`. Blocks, so
     * never call it on the main thread.
     */
    JSONObject run(JSONObject request, long timeoutMs) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        main.post(() -> {
            int id = ++nextId;
            pending.put(id, result);
            main.removeCallbacks(destroy);
            main.postDelayed(destroy, KEEP_MS);
            whenReady(() -> webView.evaluateJavascript("window.voicawNotify.run(" + id + "," + request + ")", null));
        });
        try {
            JSONObject reply = result.get(timeoutMs, TimeUnit.MILLISECONDS);
            if (reply.optBoolean("ok")) return reply;
            Log.w(TAG, "The page couldn't: " + reply.optString("error"));
        } catch (Exception e) {
            Log.w(TAG, "No answer from the page", e);
        } finally {
            main.post(() -> pending.values().remove(result));
        }
        return null;
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private void whenReady(Runnable then) {
        if (ready) {
            then.run();
            return;
        }
        waiting.add(then);
        if (webView != null) return;

        // The app's own files at https://localhost/ (as Capacitor serves them to the app), so the
        // page has the app's origin and storage. Nothing else is served, and it never navigates.
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/", new PublicAssets(context))
            .build();
        webView = new WebView(context);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }
        });
        webView.addJavascriptInterface(new Host(), "VoicawNotifyHost");
        webView.loadUrl(PAGE);
    }

    private void destroyNow() {
        if (webView != null) webView.destroy();
        webView = null;
        ready = false;
        waiting.clear();
        for (CompletableFuture<JSONObject> result : pending.values()) result.cancel(false);
        pending.clear();
    }

    /** What the page calls (on a background thread; handed to the main thread). */
    private final class Host {
        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                ready = true;
                List<Runnable> now = new ArrayList<>(waiting);
                waiting.clear();
                for (Runnable run : now) run.run();
            });
        }

        @JavascriptInterface
        public void result(int id, String json) {
            main.post(() -> {
                CompletableFuture<JSONObject> result = pending.remove(id);
                if (result == null) return;
                try {
                    result.complete(new JSONObject(json));
                } catch (Exception e) {
                    result.completeExceptionally(e);
                }
            });
        }
    }

    /** The built web app, as `cap sync` copies it into the APK's assets/public/. */
    static final class PublicAssets implements WebViewAssetLoader.PathHandler {
        private final Context context;

        PublicAssets(Context context) {
            this.context = context;
        }

        @Override
        public WebResourceResponse handle(@NonNull String path) {
            if (path.isEmpty() || path.contains("..")) return null;
            try {
                String extension = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(path, "/."));
                String type = "js".equals(extension) || "mjs".equals(extension)
                    ? "text/javascript"
                    : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return new WebResourceResponse(type, null, context.getAssets().open("public/" + path));
            } catch (IOException e) {
                return null;
            }
        }
    }
}
