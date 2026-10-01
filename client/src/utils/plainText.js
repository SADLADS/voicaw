// Text that markdown (with every plugin messages use) would draw as one paragraph, exactly as
// typed: one line of ASCII letters, digits, spaces and a little punctuation. No markdown
// markers, links (www. is one to GFM), emoji, :shortcodes:, mentions or entities, no list
// number at the start ("1."), no spaces at the ends (pre-wrap would show them). Such text can
// skip the parser, which matters with dozens of embed fields on screen (MessageList).
const PLAIN = /^[A-Za-z0-9,.'"?!/]+(?: +[A-Za-z0-9,.'"?!/]+)*$/;

export function isPlainText(text) {
  return typeof text === 'string' && PLAIN.test(text) && !/^\d+[.)]/.test(text) && !/www\./i.test(text);
}
