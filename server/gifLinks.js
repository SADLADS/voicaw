const { getSetting } = require('./appSettings');

// Links to GIF sites' pages (klipy.com/gifs/…, tenor.com/view/…) as link previews: Discord's
// `gifv` embed, drawn by the app as the GIF alone (the link hidden when it's the whole message),
// as GIFs from the picker are. Klipy's pages are behind a bot check, so its GIFs are looked up by
// their slug with Klipy's Items API, with the picker's key (none set: no preview). Klipy sees our
// server asking for that GIF, never who posted or reads it. Tenor's pages say which file is
// theirs (og:image, an animated GIF; og:video, its MP4). Readers load the GIF from the site,
// as other previews' pictures.

const KLIPY_API = 'https://api.klipy.com/api/v1';
const KLIPY_PAGE = /^https:\/\/(?:www\.)?klipy\.com\/gifs\/([a-z0-9-]{1,150})\/?(?:[?#].*)?$/i;
const TENOR_PAGE = /^https:\/\/(?:www\.)?tenor\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/[^/?#]+/i;
const TENOR_MEDIA = /^https:\/\/media\d*\.tenor\.com\//;

const positive = (n) => (Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : undefined);

// Whether `link` is a GIF page this module previews.
const isGifPage = (link) => KLIPY_PAGE.test(link) || TENOR_PAGE.test(link);

async function klipyEmbed(link, slug) {
  const key = await getSetting('klipyApiKey');
  if (!key) return null;
  const url = new URL(`${KLIPY_API}/${encodeURIComponent(key)}/gifs/items`);
  url.searchParams.set('slugs', slug.toLowerCase());
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Klipy answered ${response.status}`);
    body = await response.json();
  } catch (err) {
    // Not the URL: it contains the key.
    console.error(`Klipy GIF lookup failed: ${err.message}`);
    return null;
  }
  const { toGif } = require('./routes/gifs');
  const items = Array.isArray(body?.data?.data) ? body.data.data : [];
  const gif = items.map(toGif).find(Boolean);
  if (!gif) return null;
  return {
    type: 'gifv',
    url: link,
    provider: { name: 'KLIPY', url: 'https://klipy.com' },
    thumbnail: { url: gif.url, width: gif.width, height: gif.height },
  };
}

// Tenor's page, read as any other page's preview (`page`: linkPreviews' embed for it).
function tenorEmbed(link, page) {
  const picture = page?.image ?? page?.thumbnail;
  if (!picture?.url || !TENOR_MEDIA.test(picture.url)) return null;
  const embed = {
    type: 'gifv',
    url: link,
    provider: { name: 'Tenor', url: 'https://tenor.com' },
    thumbnail: { url: picture.url, width: positive(picture.width), height: positive(picture.height) },
  };
  if (page.video?.url && TENOR_MEDIA.test(page.video.url)) {
    embed.video = { url: page.video.url, width: positive(page.video.width), height: positive(page.video.height) };
  }
  return embed;
}

// The preview for a GIF page: an embed, null (none), or undefined (not a GIF page: preview it
// as usual). `fetchPage(link)` is linkPreviews' own fetch of a page, for Tenor.
async function gifPagePreview(link, fetchPage) {
  const klipy = KLIPY_PAGE.exec(link);
  if (klipy) return klipyEmbed(link, klipy[1]);
  if (TENOR_PAGE.test(link)) return tenorEmbed(link, await fetchPage(link));
  return undefined;
}

module.exports = { gifPagePreview, isGifPage };
