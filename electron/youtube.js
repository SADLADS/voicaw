// YouTube's player refuses to play without a Referer naming the site it's embedded in
// ("Error 153: Video player configuration error"). Chromium never sends one from our
// voicaw:// pages, so requests for the embed page (client UrlPreviews) get the web app's
// address, which is what YouTube sees from app.voicaw.com anyway.
const EMBED_URLS = ['https://www.youtube-nocookie.com/embed/*', 'https://www.youtube.com/embed/*'];
const REFERER = 'https://app.voicaw.com/';

function withYouTubeReferer(requestHeaders) {
    if (requestHeaders.Referer) return requestHeaders;
    return { ...requestHeaders, Referer: REFERER };
}

// (Registered with apiLogin.js's in main.js: a session has one onBeforeSendHeaders listener.)
module.exports = { REFERER, EMBED_URLS, withYouTubeReferer };
