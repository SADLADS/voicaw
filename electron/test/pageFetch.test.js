import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { fetchPage } = require('../pageFetch.js');

describe('fetching pages for link previews (pageFetch.js)', () => {
    let server;
    let base;
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            if (req.url === '/page') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><head><meta property="og:title" content="Clip"></head><body>' + 'x'.repeat(2 * 1024 * 1024) + '</body></html>');
            } else if (req.url === '/moved') {
                res.writeHead(302, { Location: '/page' });
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'video/mp4' });
                res.end(Buffer.alloc(1024));
            }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => server.close());
    afterEach(() => { delete process.env.LINK_PREVIEWS_ALLOW_PRIVATE; });

    it("uses the same safeFetch as the server's", () => {
        const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
        expect(read('../safeFetch.js')).toBe(read('../../server/safeFetch.js'));
    });

    it('refuses addresses that are not on the public internet', async () => {
        expect(await fetchPage(`${base}/page`)).toBeNull();
        expect(await fetchPage('file:///etc/passwd')).toBeNull();
        expect(await fetchPage(42)).toBeNull();
    });

    it("reads a page's first megabyte after redirects, and nothing of a video", async () => {
        process.env.LINK_PREVIEWS_ALLOW_PRIVATE = '1';
        const page = await fetchPage(`${base}/moved`);
        expect(page).toMatchObject({ status: 200, url: `${base}/page`, contentType: 'text/html' });
        expect(page.html.startsWith('<html><head><meta property="og:title" content="Clip">')).toBe(true);
        expect(page.html.length).toBeLessThanOrEqual(1024 * 1024);
        expect(await fetchPage(`${base}/clip`)).toEqual({ status: 200, url: `${base}/clip`, contentType: 'video/mp4' });
    });
});
