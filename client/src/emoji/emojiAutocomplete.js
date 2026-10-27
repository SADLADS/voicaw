import { customEmojiByName, customEmojiUrl, customUsageId, searchCustomEmoji } from './customEmoji';
import { getSkinTone, recordEmojiUse, skinFor } from './emojiUsage';

// The ":shortcode" autocomplete of the message editors (the message box and editing a message
// in place), like Discord's.

// ":smi" right after a space/bracket or at the start (so not "12:30" or "https://").
export const EMOJI_QUERY = /(?:^|[\s([{])(:[a-z0-9_+-]{2,})$/i;
// A complete ":shortcode:" just typed.
export const EMOJI_SHORTCODE = /(?:^|[\s([{]):([a-z0-9_+-]+):$/i;

// What the editor needs to show a custom emoji.
export function customEmojiNode(emoji, s3Endpoint) {
  return { id: String(emoji.id), name: emoji.name, url: customEmojiUrl(emoji.id, s3Endpoint) };
}

// The ":smi" being typed before the cursor, or null.
export function emojiQueryOf(beforeCaret, emojiIndex) {
  return emojiIndex ? EMOJI_QUERY.exec(beforeCaret)?.[1] ?? null : null;
}

// Custom emoji first, then standard ones (8 in all).
export function searchEmojiSuggestions(query, emojiIndex, custom) {
  return [...searchCustomEmoji(custom, query.slice(1), 8), ...emojiIndex.search(query.slice(1), 8)].slice(0, 8);
}

// A suggestion picked: the ":smi" typed becomes the emoji.
export function insertSuggestedEmoji(editor, query, emoji, s3Endpoint) {
  if (emoji.guild) {
    recordEmojiUse(customUsageId(emoji.id));
    editor?.replaceBeforeCaretWithCustomEmoji(query.length, customEmojiNode(emoji, s3Endpoint));
  } else {
    recordEmojiUse(emoji.id);
    editor?.replaceBeforeCaret(query.length, `${skinFor(emoji, getSkinTone()).native} `);
  }
}

// Typing the closing colon of a known :shortcode: turns it into the emoji (like Discord): a
// standard one, else a custom emoji of that name. `line` is the text before the cursor after
// the edit; `getEditor` gives the editor once that edit has finished.
export function replaceTypedShortcode(line, getEditor, { emojiIndex, custom, s3Endpoint }) {
  const typed = emojiIndex && EMOJI_SHORTCODE.exec(line);
  if (!typed) return;
  const emoji = emojiIndex.byShortcode.get(typed[1].toLowerCase());
  const customEmoji = !emoji && customEmojiByName(custom, typed[1]);
  if (customEmoji) {
    recordEmojiUse(customUsageId(customEmoji.id));
    queueMicrotask(() => {
      const editor = getEditor();
      if (editor && !editor.isComposing()) {
        editor.replaceBeforeCaretWithCustomEmoji(typed[1].length + 2, customEmojiNode(customEmoji, s3Endpoint), { focus: false });
      }
    });
  }
  if (emoji) {
    recordEmojiUse(emoji.id);
    const native = skinFor(emoji, getSkinTone()).native;
    // After this edit has finished (and not in the middle of a keyboard's composition).
    queueMicrotask(() => {
      const editor = getEditor();
      if (editor && !editor.isComposing()) editor.replaceBeforeCaret(typed[1].length + 2, native, { focus: false });
    });
  }
}
