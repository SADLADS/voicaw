package com.voicaw.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * The login, kept by the app so the page never holds it, as the desktop app's main process does
 * (electron/apiLogin.js; security audit follow-up). The web app keeps its login in an HttpOnly
 * cookie, but the Android page (https://localhost) is cross-site to the API and recent WebViews
 * never send it a cross-site cookie, whatever the app says (WebView 157 refused it even within one
 * run; android-v1.3.1 to 1.3.3 logged out at every start). So the page's requests to the API are
 * made here instead (client/src/utils/androidApi.js): this takes `voicaw_session` out of the
 * API's answers (logging in, a renewal, a logout clearing it) into the app's private storage and
 * strips it, and adds the token as `Authorization: Bearer` to requests that name their session
 * (`X-Voicaw-Session`). The page only ever sees `{ id, username, sid, iat }`.
 *
 * Only for the built-in server's API, whose address comes from the build (voicaw-api.json,
 * client/vite.config.js), never from the page: a script slipped into the page can make requests
 * as it could anyway, but can't read the token or send it anywhere else.
 */
final class ApiLogin {
    static final String COOKIE = "voicaw_session";
    private static final String PREFS = "voicaw_api_login";
    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9_\\-.]{1,4096}$");
    private static final ExecutorService requests = Executors.newFixedThreadPool(6);
    /** The largest answer read (the API's are JSON, far smaller). */
    private static final int MAX_ANSWER = 16 * 1024 * 1024;

    private ApiLogin() {}

    private static String prefix;
    private static boolean prefixRead;

    /** The built-in API's address ("https://app.voicaw.com/api/"), or null. */
    static synchronized String apiPrefix(Context context) {
        if (!prefixRead) {
            prefixRead = true;
            try (InputStream in = context.getAssets().open("public/voicaw-api.json")) {
                prefix = prefixFrom(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            } catch (Exception e) {
                prefix = null;
            }
        }
        return prefix;
    }

    /** The API's address in voicaw-api.json's text ({ "api": "https://host/api/" }), or null. */
    static String prefixFrom(String json) {
        try {
            return prefixOf(new JSONObject(json).getString("api"));
        } catch (Exception e) {
            return null;
        }
    }

    /** An https API address as a prefix ending in "/", or null. */
    static String prefixOf(String address) {
        try {
            URL api = new URL(address);
            if (!"https".equals(api.getProtocol()) || api.getUserInfo() != null) return null;
            String path = api.getPath().endsWith("/") ? api.getPath() : api.getPath() + "/";
            return "https://" + api.getAuthority() + path;
        } catch (Exception e) {
            return null;
        }
    }

    /** Whether `url` is the API's (exactly under its address: no tricks with "api.example.com.evil"). */
    static boolean isApi(String prefix, String url) {
        return prefix != null && url != null && url.startsWith(prefix) && !url.contains("\\") && !url.contains("@");
    }

    private static final Pattern SID = Pattern.compile("\"sid\"\\s*:\\s*\"([A-Za-z0-9_\\-]{1,200})\"");

    /** The session id in a token ("x.<claims>.y"), or null. Only read: the server checks it. */
    static String sidOf(String token) {
        try {
            String[] parts = token.split("\\.");
            String claims = new String(java.util.Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            java.util.regex.Matcher found = SID.matcher(claims);
            return found.find() ? found.group(1) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** The login cookie's value in a Set-Cookie line: the token, "" (cleared), or null (another cookie). */
    static String cookieValue(String line) {
        if (line == null) return null;
        String trimmed = line.trim();
        if (!trimmed.startsWith(COOKIE + "=")) return null;
        String value = trimmed.substring(COOKIE.length() + 1);
        int end = value.indexOf(';');
        return (end < 0 ? value : value.substring(0, end)).trim();
    }

    /**
     * What a login cookie in an answer does to the saved token (desktop's rule): a login (no
     * session named) is always taken; a renewal or a logout only for the session saved now, not
     * an answer to an older one's request arriving late. Returns the new token, "" to forget it,
     * or null to leave it.
     */
    static String nextToken(String value, String namedSession, String savedToken) {
        if (value == null) return null;
        if (namedSession != null) {
            String savedSid = savedToken == null ? null : sidOf(savedToken);
            if (savedSid == null || !savedSid.equals(namedSession)) return null;
        }
        if (value.isEmpty()) return "";
        return TOKEN.matcher(value).matches() ? value : null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String savedToken(Context context) {
        String token = prefs(context).getString("token", null);
        return token != null && TOKEN.matcher(token).matches() ? token : null;
    }

    private static void save(Context context, String token) {
        if (token == null || token.isEmpty()) prefs(context).edit().remove("token").commit();
        else prefs(context).edit().putString("token", token).commit();
    }

    /** Logging out on this phone without the server (utils/loginToken.js): the token goes. */
    static void forget(Context context) {
        save(context, null);
    }

    /** Makes the page's request (as JSON, androidApi.js) on another thread; `done` gets the answer as JSON. */
    static void request(Context context, String requestJson, Consumer<String> done) {
        requests.execute(() -> done.accept(perform(context, requestJson).toString()));
    }

    private static JSONObject failure(String kind) {
        JSONObject answer = new JSONObject();
        try {
            answer.put("error", kind);
        } catch (Exception ignored) { /* a constant key */ }
        return answer;
    }

    static JSONObject perform(Context context, String requestJson) {
        HttpURLConnection connection = null;
        try {
            JSONObject request = new JSONObject(requestJson);
            String url = request.getString("url");
            if (!isApi(apiPrefix(context), url)) return failure("not_api");
            String method = request.optString("method", "GET").toUpperCase(Locale.ROOT);
            int timeout = Math.max(0, request.optInt("timeout", 0));

            // Never the WebView's cookies (Capacitor's cookie plugin installs a handler sharing
            // them; MainActivity removes it): the login is the one kept here.
            if (java.net.CookieHandler.getDefault() != null) java.net.CookieHandler.setDefault(null);
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestMethod(method);
            connection.setConnectTimeout(timeout > 0 ? Math.min(timeout, 30000) : 30000);
            connection.setReadTimeout(timeout > 0 ? timeout : 120000);

            String named = null;
            boolean authorised = false;
            JSONObject headers = request.optJSONObject("headers");
            if (headers != null) {
                for (Iterator<String> names = headers.keys(); names.hasNext(); ) {
                    String name = names.next();
                    String lower = name.toLowerCase(Locale.ROOT);
                    // The page's cookies are the WebView's business, never sent from here.
                    if (lower.equals("cookie") || lower.equals("host") || lower.equals("content-length")) continue;
                    String value = headers.optString(name, null);
                    if (value == null || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) continue;
                    if (lower.equals("x-voicaw-session")) named = value;
                    if (lower.equals("authorization")) authorised = true;
                    connection.setRequestProperty(name, value);
                }
            }
            String saved = savedToken(context);
            // Even for a request naming an older session (logout's, sent late): the server then
            // answers that another login replaced it.
            if (named != null && saved != null && !authorised) connection.setRequestProperty("Authorization", "Bearer " + saved);

            byte[] body = null;
            if (request.has("bodyBase64")) body = java.util.Base64.getDecoder().decode(request.getString("bodyBase64"));
            else if (request.has("body")) body = request.getString("body").getBytes(StandardCharsets.UTF_8);
            if (body != null && !method.equals("GET") && !method.equals("HEAD")) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body);
                }
            }

            int status = connection.getResponseCode();
            JSONObject answerHeaders = new JSONObject();
            List<String> loginCookies = new ArrayList<>();
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                if (header.getKey() == null) continue;
                String lower = header.getKey().toLowerCase(Locale.ROOT);
                List<String> values = new ArrayList<>();
                for (String value : header.getValue()) {
                    if (lower.equals("set-cookie") && cookieValue(value) != null) loginCookies.add(value);
                    else values.add(value);
                }
                if (values.isEmpty()) continue;
                answerHeaders.put(lower, String.join(lower.equals("set-cookie") ? "\n" : ", ", values));
            }
            if (!loginCookies.isEmpty()) {
                String next = nextToken(cookieValue(loginCookies.get(loginCookies.size() - 1)), named, saved);
                if (next != null) save(context, next);
            }

            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] answer = in == null ? new byte[0] : readAll(in, MAX_ANSWER);
            JSONObject reply = new JSONObject();
            reply.put("status", status);
            reply.put("statusText", connection.getResponseMessage() == null ? "" : connection.getResponseMessage());
            reply.put("headers", answerHeaders);
            reply.put("body", new String(answer, StandardCharsets.UTF_8));
            return reply;
        } catch (SocketTimeoutException e) {
            return failure("timeout");
        } catch (IOException e) {
            return failure("network");
        } catch (Exception e) {
            return failure("bad_request");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) {
                if (bytes.size() + n > max) throw new IOException("answer too big");
                bytes.write(buffer, 0, n);
            }
            return bytes.toByteArray();
        }
    }
}
