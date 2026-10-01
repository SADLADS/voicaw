// A GIF from the picker is sent as a markdown image of Klipy's file, with its size in the URL
// fragment (never sent to the server), so the message reserves its box before it loads:
// `![GIF](https://static.klipy.com/…webp#gif&w=498&h=374)`. In encrypted chats the link is
// inside the encryption like everything else; viewers load it from Klipy.

export const GIF_ALT = 'GIF';

export function gifMarkup(gif) {
  return `![${GIF_ALT}](${gif.url}#gif&w=${gif.width}&h=${gif.height})`;
}

// { width, height } for a GIF's URL, else null.
export function parseGifUrl(url) {
  if (typeof url !== 'string') return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  if (!params.has('gif')) return null;
  const size = (v) => (/^\d{1,5}$/.test(v ?? '') && Number(v) > 0 ? Number(v) : null);
  const width = size(params.get('w'));
  const height = size(params.get('h'));
  return width && height ? { width, height } : { width: null, height: null };
}
