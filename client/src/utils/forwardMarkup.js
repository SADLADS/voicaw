// A forwarded message (as Discord's forwards): its whole text is `fwd:v1:` + a JSON header on
// the first line, then the original message's text exactly as it was:
//   fwd:v1:{"t":1730000000}
//   look at this ![photo.jpg](https://…/uploads/<uuid>.bin#v=2&k=…)
// `t` is when the original was sent (unix s). Who wrote it and where isn't kept, as in Discord.
// The text stays as it was (not JSON-escaped), so everything that reads a message's text
// (attachments and their upload names, links, guild search, previews) reads a forward's too.
// In DMs and group DMs it's inside the encryption like any message; in a guild the server
// reads it (server/forwards.js) and never pings anyone a forward mentions.
// Forwarding a forward forwards the original (its text and time), not a forward of a forward.

import { parsePoll } from './pollMarkup';
import { isEphemeral } from './botComponents';

export const FORWARD_PREFIX = 'fwd:v1:';

// { at, content } for a forward's text, else null.
export function parseForward(text) {
  if (typeof text !== 'string' || !text.startsWith(FORWARD_PREFIX)) return null;
  const lineEnd = text.indexOf('\n');
  if (lineEnd === -1) return null;
  try {
    const header = JSON.parse(text.slice(FORWARD_PREFIX.length, lineEnd));
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    const at = Number.isInteger(header.t) && header.t > 0 ? header.t : null;
    return { at, content: text.slice(lineEnd + 1) };
  } catch {
    return null;
  }
}

export const isForward = (text) => parseForward(text) !== null;

// A forward's text for `content` sent at `at` (unix s).
export function forwardMarkup({ content, at }) {
  return `${FORWARD_PREFIX}${JSON.stringify(Number.isInteger(at) && at > 0 ? { t: at } : {})}\n${content}`;
}

// What forwarding `msg` sends ({ content, at }), or null when it can't be forwarded: not sent
// yet (pending, failed), a bot's ephemeral reply or "thinking", a system row, nothing written
// (a bot's embeds or files alone) or a poll (its votes are reactions on the message itself).
// A forward is forwarded as its original.
export function forwardSource(msg) {
  if (!msg || msg.status === 'pending' || msg.status === 'failed' || isEphemeral(msg) || msg.system != null) return null;
  if (!Number.isInteger(msg.id)) return null;
  const text = msg.plaintext;
  if (typeof text !== 'string' || !text.trim()) return null;
  const forward = parseForward(text);
  if (forward) return forward.content.trim() ? { content: forward.content, at: forward.at } : null;
  if (parsePoll(text)) return null;
  return { content: text, at: Number.isInteger(msg.timestamp) ? msg.timestamp : null };
}
