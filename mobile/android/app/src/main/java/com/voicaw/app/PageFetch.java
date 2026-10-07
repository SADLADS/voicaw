package com.voicaw.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Fetching a linked page for a link preview in an end-to-end encrypted chat (the page's
 * fetchPage; see Link previews in docs/messages.md): a web page can't read other sites, and
 * asking our server would tell it the link. As the server's and the desktop app's safeFetch.js:
 * public addresses only, ports 80 and 443, up to 5 redirects, a page's first 1 MB and nothing
 * of anything else, 5 seconds in all. The address checked is the one connected to (the socket
 * is opened here, to that address, with TLS for the link's host name), so a name can't resolve
 * to a public address for the check and a private one for the connection, as it could with
 * HttpURLConnection, which looks the name up again. Plain Java, so it's tested on the JVM
 * (PageFetchTest).
 */
final class PageFetch {
    static final int MAX_HTML_BYTES = 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final long TIMEOUT_MS = 5000;
    private static final String USER_AGENT = "Mozilla/5.0 (compatible; VoicawBot/1.0; +https://voicaw.com/)";

    /** Tests only: lifts the address and port checks, as LINK_PREVIEWS_ALLOW_PRIVATE does. */
    static boolean allowPrivate = false;

    static final class Page {
        final int status;
        final String url;
        final String contentType;
        /** Pages only (text/html, application/xhtml+xml). */
        final String html;

        Page(int status, String url, String contentType, String html) {
            this.status = status;
            this.url = url;
            this.contentType = contentType;
            this.html = html;
        }
    }

    private PageFetch() {}

    static Page fetch(String href) throws IOException {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        URI url;
        try {
            url = new URI(href);
        } catch (Exception e) {
            throw new IOException("Not a web address");
        }
        for (int redirects = 0; ; redirects++) {
            Response res = requestOnce(url, deadline);
            if (res.status >= 300 && res.status < 400 && res.headers.containsKey("location")) {
                if (redirects >= MAX_REDIRECTS) throw new IOException("Too many redirects");
                try {
                    url = url.resolve(res.headers.get("location").trim());
                } catch (Exception e) {
                    throw new IOException("Bad redirect");
                }
                continue;
            }
            String html = isHtml(res.contentType) ? decode(res.body, res.charset) : null;
            return new Page(res.status, url.toString(), res.contentType, html);
        }
    }

    // ---------------------------------------------------------------- addresses

    static boolean isPublicAddress(InetAddress address) {
        if (allowPrivate) return true;
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
            || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        byte[] b = address.getAddress();
        if (address instanceof Inet4Address) return isPublicIpv4(b);
        if (address instanceof Inet6Address) {
            // NAT64 (64:ff9b::/96): the IPv4 address inside.
            if ((b[0] & 0xff) == 0x00 && (b[1] & 0xff) == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b && allZero(b, 4, 12)) {
                return isPublicIpv4(new byte[] { b[12], b[13], b[14], b[15] });
            }
            if (((b[0] & 0xff) & 0xfe) == 0xfc) return false; // fc00::/7
            if ((b[0] & 0xff) == 0x01 && b[1] == 0 && allZero(b, 2, 8)) return false; // 100::/64
            if ((b[0] & 0xff) == 0x20 && (b[1] & 0xff) == 0x01 && (b[2] & 0xff) == 0x0d && (b[3] & 0xff) == 0xb8) return false; // 2001:db8::/32
            return true;
        }
        return false;
    }

    private static boolean allZero(byte[] b, int from, int to) {
        for (int i = from; i < to; i++) if (b[i] != 0) return false;
        return true;
    }

    private static boolean isPublicIpv4(byte[] b) {
        int a0 = b[0] & 0xff;
        int a1 = b[1] & 0xff;
        int a2 = b[2] & 0xff;
        if (a0 == 0 || a0 == 10 || a0 == 127 || a0 >= 224) return false;
        if (a0 == 100 && a1 >= 64 && a1 < 128) return false; // CGNAT
        if (a0 == 169 && a1 == 254) return false;
        if (a0 == 172 && a1 >= 16 && a1 < 32) return false;
        if (a0 == 192 && a1 == 168) return false;
        if (a0 == 192 && a1 == 0 && (a2 == 0 || a2 == 2)) return false;
        if (a0 == 198 && (a1 == 18 || a1 == 19)) return false;
        if (a0 == 198 && a1 == 51 && a2 == 100) return false;
        if (a0 == 203 && a1 == 0 && a2 == 113) return false;
        return true;
    }

    // ---------------------------------------------------------------- one request

    private static final class Response {
        int status;
        final Map<String, String> headers = new HashMap<>();
        String contentType = "";
        String charset;
        byte[] body = new byte[0];
    }

    private static Response requestOnce(URI url, long deadline) throws IOException {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) throw new IOException("Not a web address");
        if (url.getRawUserInfo() != null) throw new IOException("No credentials in URLs");
        String host = url.getHost();
        if (host == null || host.isEmpty()) throw new IOException("No host");
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        boolean https = scheme.equals("https");
        int port = url.getPort() == -1 ? (https ? 443 : 80) : url.getPort();
        if (!allowPrivate && port != 80 && port != 443) throw new IOException("Only ports 80 and 443");

        InetAddress target = null;
        for (InetAddress address : InetAddress.getAllByName(host)) {
            if (isPublicAddress(address)) {
                target = address;
                break;
            }
        }
        if (target == null) throw new IOException(host + " is not a public address");

        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(target, port), (int) left(deadline));
            socket.setSoTimeout((int) left(deadline));
            if (https) {
                SSLSocket tls = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(socket, host, port, true);
                tls.startHandshake();
                HostnameVerifier verifier = HttpsURLConnection.getDefaultHostnameVerifier();
                if (!verifier.verify(host, tls.getSession())) throw new IOException("Certificate isn't for " + host);
                socket = tls;
            }
            String path = url.getRawPath() == null || url.getRawPath().isEmpty() ? "/" : url.getRawPath();
            if (url.getRawQuery() != null) path += "?" + url.getRawQuery();
            boolean defaultPort = url.getPort() == -1;
            String hostHeader = (host.contains(":") ? "[" + host + "]" : host) + (defaultPort ? "" : ":" + port);
            String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "User-Agent: " + USER_AGENT + "\r\n"
                + "Accept: text/html,application/xhtml+xml,image/*,video/*;q=0.8,*/*;q=0.5\r\n"
                + "Accept-Encoding: gzip\r\n"
                + "Connection: close\r\n\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(request.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            return readResponse(socket.getInputStream(), deadline);
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Closed anyway.
            }
        }
    }

    private static long left(long deadline) throws IOException {
        long ms = deadline - System.currentTimeMillis();
        if (ms <= 0) throw new IOException("Timed out");
        return ms;
    }

    private static String readLine(InputStream in, int[] budget) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (--budget[0] < 0) throw new IOException("Headers too long");
            if (c == '\n') break;
            if (c != '\r') line.write(c);
        }
        if (c == -1 && line.size() == 0) throw new IOException("Connection closed");
        return line.toString("ISO-8859-1");
    }

    private static Response readResponse(InputStream raw, long deadline) throws IOException {
        Response res = new Response();
        int[] budget = { MAX_HEADER_BYTES };
        Matcher status = Pattern.compile("^HTTP/\\d(?:\\.\\d)? (\\d{3})").matcher(readLine(raw, budget));
        if (!status.find()) throw new IOException("Not HTTP");
        res.status = Integer.parseInt(status.group(1));
        for (String line; !(line = readLine(raw, budget)).isEmpty(); ) {
            int colon = line.indexOf(':');
            if (colon > 0) res.headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
        String type = res.headers.getOrDefault("content-type", "");
        String[] parts = type.split(";");
        res.contentType = parts[0].trim().toLowerCase(Locale.ROOT);
        for (int i = 1; i < parts.length; i++) {
            Matcher m = Pattern.compile("^\\s*charset\\s*=\\s*\"?([\\w.:-]+)\"?", Pattern.CASE_INSENSITIVE).matcher(parts[i]);
            if (m.find()) res.charset = m.group(1);
        }
        // Only a page's own text is read; of a redirect, a picture or a video nothing.
        if ((res.status >= 300 && res.status < 400) || !isHtml(res.contentType)) return res;
        InputStream body = raw;
        if ("chunked".equalsIgnoreCase(res.headers.getOrDefault("transfer-encoding", ""))) body = new Chunked(raw);
        String encoding = res.headers.getOrDefault("content-encoding", "").toLowerCase(Locale.ROOT);
        if (encoding.equals("gzip") || encoding.equals("x-gzip")) body = new GZIPInputStream(body);
        else if (!encoding.isEmpty() && !encoding.equals("identity")) return res;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int n;
        try {
            while (out.size() < MAX_HTML_BYTES && (n = body.read(buffer, 0, Math.min(buffer.length, MAX_HTML_BYTES - out.size()))) != -1) {
                out.write(buffer, 0, n);
                left(deadline);
            }
        } catch (IOException e) {
            // What arrived before a cut-off is enough for a page's <head>.
            if (out.size() == 0) throw e;
        }
        res.body = out.toByteArray();
        return res;
    }

    /** A chunked body (Transfer-Encoding: chunked), as its plain bytes. */
    private static final class Chunked extends InputStream {
        private final InputStream in;
        private int remaining = 0;
        private boolean done = false;

        Chunked(InputStream in) {
            this.in = in;
        }

        private boolean nextChunk() throws IOException {
            int[] budget = { 1024 };
            String line = readLine(in, budget);
            if (line.isEmpty()) line = readLine(in, budget); // the CRLF after the previous chunk
            int semicolon = line.indexOf(';');
            remaining = Integer.parseInt((semicolon >= 0 ? line.substring(0, semicolon) : line).trim(), 16);
            if (remaining == 0) done = true;
            return !done;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) == -1 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (done) return -1;
            if (remaining == 0 && !nextChunk()) return -1;
            int n = in.read(b, off, Math.min(len, remaining));
            if (n == -1) {
                done = true;
                return -1;
            }
            remaining -= n;
            return n;
        }
    }

    // ---------------------------------------------------------------- text

    static boolean isHtml(String contentType) {
        return contentType.equals("text/html") || contentType.equals("application/xhtml+xml");
    }

    private static String decode(byte[] body, String charset) {
        String declared = charset;
        if (declared == null) {
            String start = new String(body, 0, Math.min(body.length, 2048), StandardCharsets.ISO_8859_1);
            Matcher m = Pattern.compile("<meta[^>]+charset\\s*=\\s*[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(start);
            if (m.find()) declared = m.group(1);
        }
        try {
            return new String(body, declared == null ? StandardCharsets.UTF_8 : Charset.forName(declared));
        } catch (Exception e) {
            return new String(body, StandardCharsets.UTF_8);
        }
    }
}
