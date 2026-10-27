import { summarizeAttachments } from './attachmentMarkup';
import { mentionPattern, mentionsToText } from './mentions';
import { displayName } from './profiles';
import { customEmojiToText } from '../emoji/customEmoji';
import { hideSpoilers } from './remarkDiscord';

// What a message being forwarded says, on one line (ForwardDialog, the message box's
// "Forwarding a message" bar): files by name, spoilers hidden, custom emoji `:name:`, people
// by the name everyone's profile gives (the chat it goes to may not know them), channels from
// `channels` (ChannelMentionContext's).
export function forwardPreview(content, channels) {
  const names = {};
  for (const [, id] of String(content ?? '').matchAll(mentionPattern())) {
    const name = displayName(id);
    if (name) names[id] = name;
  }
  return mentionsToText(customEmojiToText(hideSpoilers(summarizeAttachments(content))), names, null, channels)
    ?.replace(/\s+/g, ' ').trim() ?? '';
}
