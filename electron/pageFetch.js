// Fetching a linked page for a link preview in an end-to-end encrypted chat (see Link previews
// in docs/messages.md): the page can't read other sites itself, and asking our server would tell
// it the link, so the app does it here, for the page's `voicawDesktop.fetchPage`. Public
// addresses only, ports 80 and 443, up to 5 redirects, a page's first 1 MB and nothing of
// anything else, 5 seconds in all: safeFetch.js, a copy of the server's (a test keeps them
// the same). The page reads the card from what this returns (client utils/pageEmbed.js).
const { safeFetch } = require('./safeFetch');

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
// As the server's (server/linkPreviews.js): sites give bots their cards.
const USER_AGENT = 'Mozilla/5.0 (compatible; VoicawBot/1.0; +https://voicaw.com/)';

function decodeHtml(body, charset) {
    const declared = charset ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
    try {
        return new TextDecoder(declared ?? 'utf-8').decode(body);
    } catch {
        return new TextDecoder('utf-8').decode(body);
    }
}

// -> { status, url (after redirects), contentType, html (pages only) }, or null if it couldn't
// be fetched.
async function fetchPage(url) {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
    try {
        const res = await safeFetch(url, {
            maxBytes: (type) => (HTML_TYPES.has(type) ? MAX_HTML_BYTES : 0),
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,image/*,video/*;q=0.8,*/*;q=0.5' },
        });
        const page = { status: res.status, url: res.url, contentType: res.contentType };
        if (HTML_TYPES.has(res.contentType)) page.html = decodeHtml(res.body, res.charset);
        return page;
    } catch {
        return null;
    }
}

module.exports = { fetchPage };
