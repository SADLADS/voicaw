import { youtubeVideoId } from './youtube';
import { eventFromUrl, inviteCodeFromUrl } from './inviteLinks';

// Which links in a message get previews, as server/linkPreviews.js `linksIn` decides for guild
// messages: not in code, spoilers, <…> (written that way to keep a link plain, as in Discord)
// or a markdown image (an attachment or a GIF), trailing punctuation dropped, at most
// MAX_LINKS, without repeats.

const MAX_LINKS = 5;

// Discord's message flag: the message's embeds and link previews are hidden ("Remove previews").
export const SUPPRESS_EMBEDS = 1 << 2;
const LINK_RE = /https?:\/\/[^\s<>"'`|]+/gi;

export function linksIn(text) {
  if (typeof text !== 'string') return [];
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\|\|[\s\S]*?\|\|/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<https?:\/\/[^\s>]*>/gi, ' ');
  const links = [];
  for (let [link] of plain.matchAll(LINK_RE)) {
    link = link.replace(/[.,!?:;*_~]+$/, '');
    while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) {
      link = link.slice(0, -1).replace(/[.,!?:;*_~]+$/, '');
    }
    try {
      link = new URL(link).href;
    } catch {
      continue;
    }
    if (!links.includes(link)) links.push(link);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

// Links the app draws in its own way (UrlPreviews: YouTube players, guild invite cards and
// event cards), so a preview made for them isn't shown as well.
export const drawnByApp = (link) =>
  Boolean(youtubeVideoId(link) || inviteCodeFromUrl(link) || eventFromUrl(link));

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO_PATH = /\.(mp4|webm|mov|m4v)$/i;

// 'image' or 'video' for a link whose address plainly ends in a picture's or a video's file
// name, else null. In DMs and group DMs (whose links the server never sees) that's all there is
// to go on: such links show the file, loaded by the reader from that site.
export function mediaLinkKind(link) {
  let pathname;
  try {
    ({ pathname } = new URL(link));
  } catch {
    return null;
  }
  if (IMAGE_PATH.test(pathname)) return 'image';
  if (VIDEO_PATH.test(pathname)) return 'video';
  return null;
}

// A name for a linked file: the last part of its address ("cat.png"), else the site.
export function linkFileName(link) {
  try {
    const { pathname, hostname } = new URL(link);
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '') || hostname;
  } catch {
    return link;
  }
}

export function siteOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
