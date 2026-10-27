// Forwarded messages (client utils/forwardMarkup.js): a message whose text is `fwd:v1:` + a
// JSON header on the first line (`{ t }`: when the original was sent, unix s), then the
// original's text as it was. The server only reads them in guilds (in DMs and groups they're
// encrypted): their mentions never ping (mentions.js), pushes say "↪ Forwarded: …", search
// finds their text and `has:forward` (searchText.js), and bots see Discord's forward
// (discord.js: a `message_reference` of type 1 and `message_snapshots`).
const FORWARD_PREFIX = 'fwd:v1:';

// { at, content } for a forward's text, else null.
function parseForward(text) {
  if (typeof text !== 'string' || !text.startsWith(FORWARD_PREFIX)) return null;
  const lineEnd = text.indexOf('\n');
  if (lineEnd === -1) return null;
  try {
    const header = JSON.parse(text.slice(FORWARD_PREFIX.length, lineEnd));
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    return { at: Number.isInteger(header.t) && header.t > 0 ? header.t : null, content: text.slice(lineEnd + 1) };
  } catch {
    return null;
  }
}

// What a forward forwards (its text), else null.
const forwardedContent = (text) => parseForward(text)?.content ?? null;

module.exports = { FORWARD_PREFIX, parseForward, forwardedContent };
