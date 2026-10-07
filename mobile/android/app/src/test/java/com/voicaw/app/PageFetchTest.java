package com.voicaw.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** PageFetch against a local server (with allowPrivate, as the e2e harness does), and its address checks. */
public class PageFetchTest {
    private ServerSocket server;
    private Thread serving;
    private String base;

    private static void respond(Socket socket) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
        String path = in.readLine().split(" ")[1];
        while (!in.readLine().isEmpty()) {
            // Headers aren't needed.
        }
        OutputStream out = socket.getOutputStream();
        if (path.equals("/moved")) {
            out.write("HTTP/1.1 302 Found\r\nLocation: /page\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        } else if (path.equals("/page")) {
            // Chunked, longer than the 1 MB read.
            out.write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            byte[] head = "<html><head><meta property=\"og:title\" content=\"Clip ✓\"></head><body>".getBytes(StandardCharsets.UTF_8);
            byte[] filler = new byte[64 * 1024];
            Arrays.fill(filler, (byte) 'x');
            try {
                for (int i = 0; i < 33; i++) {
                    byte[] chunk = i == 0 ? head : filler;
                    out.write((Integer.toHexString(chunk.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.write(chunk);
                    out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
                }
                out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            } catch (Exception ignored) {
                // The reader stops at 1 MB.
            }
        } else {
            out.write("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1024\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            try {
                out.write(new byte[1024]);
            } catch (Exception ignored) {
                // Not read.
            }
        }
        out.flush();
    }

    @Before
    public void start() throws Exception {
        server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
        base = "http://127.0.0.1:" + server.getLocalPort();
        serving = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    respond(socket);
                } catch (Exception ignored) {
                    // Closed, or the client went away.
                }
            }
        });
        serving.start();
    }

    @After
    public void stop() throws Exception {
        server.close();
        serving.join(2000);
        PageFetch.allowPrivate = false;
    }

    @Test
    public void refusesAddressesNotOnThePublicInternet() throws Exception {
        assertThrows(Exception.class, () -> PageFetch.fetch(base + "/page"));
        assertThrows(Exception.class, () -> PageFetch.fetch("file:///etc/passwd"));
        for (String address : new String[] {
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
            "::1", "fe80::1", "fd00::1", "64:ff9b::a00:1", "::ffff:192.168.0.1", "224.0.0.1",
        }) {
            assertFalse(address, PageFetch.isPublicAddress(InetAddress.getByName(address)));
        }
        assertTrue(PageFetch.isPublicAddress(InetAddress.getByName("93.184.215.14")));
        assertTrue(PageFetch.isPublicAddress(InetAddress.getByName("2606:4700::1")));
        assertTrue(PageFetch.isPublicAddress(InetAddress.getByName("64:ff9b::808:808")));
    }

    @Test
    public void readsAPagesFirstMegabyteAfterRedirects() throws Exception {
        PageFetch.allowPrivate = true;
        PageFetch.Page page = PageFetch.fetch(base + "/moved");
        assertEquals(200, page.status);
        assertEquals(base + "/page", page.url);
        assertEquals("text/html", page.contentType);
        assertTrue(page.html.startsWith("<html><head><meta property=\"og:title\" content=\"Clip ✓\">"));
        assertTrue(page.html.length() <= PageFetch.MAX_HTML_BYTES);
        assertTrue(page.html.length() > 512 * 1024);
    }

    @Test
    public void readsNothingOfAVideo() throws Exception {
        PageFetch.allowPrivate = true;
        PageFetch.Page page = PageFetch.fetch(base + "/clip");
        assertEquals("video/mp4", page.contentType);
        assertNull(page.html);
    }
}
