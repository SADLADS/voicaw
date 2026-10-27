import { useState } from 'react';
import { useEmojiIndex } from '../emoji/emojiContext';
import { useCustomEmoji } from '../emoji/customEmojiContext';
import {
  emojiQueryOf,
  insertSuggestedEmoji,
  replaceTypedShortcode,
  searchEmojiSuggestions,
} from '../emoji/emojiAutocomplete';
import { searchChannels, searchMentions } from '../utils/mentions';

// "@", "@na": a mention being typed (not "a@b").
const MENTION_QUERY = /(?:^|[\s([{])@([^\s@<>]{0,32})$/;
// "#", "#gen": a channel being typed (not "a#b").
const CHANNEL_QUERY = /(?:^|[\s([{])#([^\s#<>]{0,100})$/;

// The suggestions of a message editor (EditorSuggestions draws them), for the message box
// (Composer, which adds bot commands) and editing a message in place (InlineMessageEdit):
// ":smi" emoji (and ":shortcode:" turning into the emoji), "@na" mentions from `people`
// ([{ id, username }]; in a guild also `roles`, [{ id, name, color }], and @everyone/@here with
// `canMentionEveryone`; `roleInfo`, { id: { color } }, colours the role mentions put in) and
// "#gen" channels from `channels` ([{ id, name, type, private, category }]).
// `editorRef` is the MessageEditor's handle; pass `onChange` and `onKeyDown` on to it, the latter
// first (it says whether it took the key).
export function useEditorSuggestions(editorRef, { s3Endpoint, people, roles, roleInfo, canMentionEveryone = false, channels } = {}) {
  const emojiIndex = useEmojiIndex();
  const custom = useCustomEmoji();
  // The editor's current line up to the cursor.
  const [beforeCaret, setBeforeCaret] = useState('');
  const [index, setIndex] = useState(0);
  // The query (":smi", "@na" or "#gen") whose suggestions Escape closed.
  const [dismissed, setDismissed] = useState(null);

  // Only one kind can match what's before the cursor.
  let kind = null;
  let query = null;
  let items = [];
  const emojiQuery = emojiQueryOf(beforeCaret, emojiIndex);
  const mentionQuery = people?.length ? MENTION_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  const channelQuery = channels?.length ? CHANNEL_QUERY.exec(beforeCaret)?.[1] ?? null : null;
  if (emojiQuery && emojiQuery !== dismissed) {
    [kind, query, items] = ['emoji', emojiQuery, searchEmojiSuggestions(emojiQuery, emojiIndex, custom)];
  }
  if (items.length === 0 && mentionQuery != null && `@${mentionQuery}` !== dismissed) {
    [kind, query, items] = ['mention', mentionQuery, searchMentions({ people, roles, everyone: canMentionEveryone }, mentionQuery)];
  }
  if (items.length === 0 && channelQuery != null && `#${channelQuery}` !== dismissed) {
    [kind, query, items] = ['channel', channelQuery, searchChannels(channels, channelQuery)];
  }
  if (items.length === 0) kind = null;
  const activeIndex = Math.min(index, Math.max(items.length - 1, 0));

  function pick(item) {
    const editor = editorRef.current;
    if (kind === 'emoji') {
      insertSuggestedEmoji(editor, query, item, s3Endpoint);
    } else if (kind === 'channel') {
      editor?.replaceBeforeCaretWithChannelMention(query.length + 1, { id: item.id, name: item.name });
    } else if (item.kind === 'role') {
      editor?.replaceBeforeCaretWithRoleMention(query.length + 1, { id: item.id, name: item.name, color: roleInfo?.[item.id]?.color });
    } else if (item.kind === 'everyone') {
      editor?.replaceBeforeCaret(query.length + 1, `@${item.name} `);
    } else {
      editor?.replaceBeforeCaretWithMention(query.length + 1, { id: item.id, name: item.name });
    }
    setIndex(0);
  }

  // `replaceShortcodes` false: a change that isn't typing (a draft put back).
  function onChange({ beforeCaret: line, docChanged }, { replaceShortcodes = true } = {}) {
    setBeforeCaret(line);
    if (!docChanged || !replaceShortcodes) return;
    setIndex(0);
    replaceTypedShortcode(line, () => editorRef.current, { emojiIndex, custom, s3Endpoint });
  }

  // True when the key moved through, picked or closed the suggestions.
  function onKeyDown(e) {
    if (!kind) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((activeIndex + step + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(items[activeIndex]);
    } else if (e.key === 'Escape') {
      setDismissed(kind === 'emoji' ? query : `${kind === 'mention' ? '@' : '#'}${query}`);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  return { kind, query, items, activeIndex, setActiveIndex: setIndex, pick, onChange, onKeyDown, beforeCaret };
}
