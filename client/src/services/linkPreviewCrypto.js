import { encryptMessage, decryptMessage, toBase64 } from './encryptionService';
import { encryptGroupMessage, decryptGroupMessage, SIGNED_PREFIX } from './groupCrypto';
import { linksIn } from '../utils/linkPreviews';

// Link previews in end-to-end encrypted chats (see Link previews in docs/messages.md): the
// sender's app makes them (services/linkPreviewService.js) and stores them beside the message
// (`link_previews`), encrypted with the same key. Each is bound to its message: the message's
// id is in the encryption context and the payload names the message's ciphertext by its hash,
// so the server can't move previews to another message or keep them past an edit; in a group
// they're also signed by the sender like the message (a member can't make them for someone
// else's). The payload, before encryption: {"v":1,"content":"<base64 SHA-256 of the message's
// stored content>","embeds":[...Discord-shaped embeds, as server/linkPreviews.js makes]}.
// Opened previews are checked again (opening never throws: a bad set is just not shown): only
// for links in the message's text, at most 5, and only the fields and http(s) addresses an embed
// may have; their text is drawn as plain text, as a guild's are.

const DM_CONTEXT = 'voicaw/link-previews/v1';
const GROUP_CONTEXT = 'voicaw/group-link-previews/v1';
const GROUP_SIGNATURE_CONTEXT = 'voicaw/group-link-previews-sig/v1';

// server/config.js MAX_LINK_PREVIEWS_BYTES
export const MAX_PREVIEWS_BYTES = 16 * 1024;
const MAX_EMBEDS = 5;

const te = new TextEncoder();

export const dmPreviewsContext = (messageId, senderId, recipientId) => `${DM_CONTEXT}|${messageId}|${senderId}|${recipientId}`;

export const groupPreviewsContext = (groupId, epoch, messageId, senderId) => `${GROUP_CONTEXT}|${groupId}|${epoch}|${messageId}|${senderId}`;

export const groupPreviewsSignatureContext = (groupId, epoch, messageId, senderId) =>
  `${GROUP_SIGNATURE_CONTEXT}|${groupId}|${epoch}|${messageId}|${senderId}`;

async function contentHash(content) {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(content))));
}

// The payload for `embeds` (as many as fit) on the message stored as `content`, or null for none.
async function payload(embeds, content) {
  const hash = await contentHash(content);
  for (let n = Math.min(embeds.length, MAX_EMBEDS); n > 0; n--) {
    const json = JSON.stringify({ v: 1, content: hash, embeds: embeds.slice(0, n) });
    if (te.encode(json).length <= MAX_PREVIEWS_BYTES) return json;
  }
  return null;
}

const EMBED_TYPES = new Set(['link', 'article', 'video', 'image']);

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

function webAddress(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const size = (value) => (Number.isInteger(value) && value > 0 && value < 100000 ? value : undefined);

// Only the defined fields, so a checked embed has no `undefined` in it.
function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

function media(value) {
  const url = value && typeof value === 'object' ? webAddress(value.url) : undefined;
  return url ? defined({ url, width: size(value.width), height: size(value.height) }) : undefined;
}

// An embed as it may be drawn, or null.
export function checkedEmbed(embed) {
  if (!embed || typeof embed !== 'object' || !EMBED_TYPES.has(embed.type)) return null;
  const url = webAddress(embed.url);
  if (!url) return null;
  const providerName = text(embed.provider?.name, 256);
  const checked = defined({
    type: embed.type,
    url,
    title: text(embed.title, 256),
    description: text(embed.description, 350),
    color: Number.isInteger(embed.color) && embed.color >= 0 && embed.color <= 0xffffff ? embed.color : undefined,
    provider: providerName ? { name: providerName } : undefined,
    image: media(embed.image),
    thumbnail: media(embed.thumbnail),
    video: media(embed.video),
  });
  return checked.title || checked.description || checked.image || checked.thumbnail || checked.video ? checked : null;
}

// The embeds in an opened payload, if it's for this message (`content`, `messageText`).
async function embedsIn(json, content, messageText) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (data?.v !== 1 || !Array.isArray(data.embeds) || data.content !== await contentHash(content)) return null;
  const links = new Set(linksIn(messageText));
  const seen = new Set();
  const embeds = [];
  for (const embed of data.embeds.slice(0, MAX_EMBEDS)) {
    const checked = checkedEmbed(embed);
    if (!checked || !links.has(checked.url) || seen.has(checked.url)) continue;
    seen.add(checked.url);
    embeds.push(checked);
  }
  return embeds.length ? embeds : null;
}

// -> the envelope to store for a DM's (or a note's) previews, or null if there are none.
export async function sealDmPreviews(embeds, content, key, context) {
  const json = await payload(embeds, content);
  return json && encryptMessage(json, key, context);
}

// -> the embeds to show, or null.
export async function openDmPreviews(envelope, content, messageText, key, context) {
  if (typeof envelope !== 'string' || typeof content !== 'string' || !key) return null;
  try {
    return await embedsIn(await decryptMessage(envelope, key, context), content, messageText);
  } catch {
    return null;
  }
}

// -> the envelope for a group message's previews (signed with `signingKey`), or null.
export async function sealGroupPreviews(embeds, content, epochKey, context, signingKey, signatureContext) {
  const json = await payload(embeds, content);
  return json && encryptGroupMessage(json, epochKey, context, signingKey, signatureContext);
}

// -> the embeds to show, or null: only signed by the message's sender (`identityKey`).
export async function openGroupPreviews(envelope, content, messageText, epochKey, context, identityKey, signatureContext) {
  if (typeof envelope !== 'string' || !envelope.startsWith(SIGNED_PREFIX) || typeof content !== 'string' || !epochKey || !identityKey) return null;
  try {
    const { text: json, verified } = await decryptGroupMessage(envelope, epochKey, context, identityKey, signatureContext);
    return verified ? await embedsIn(json, content, messageText) : null;
  } catch {
    return null;
  }
}
