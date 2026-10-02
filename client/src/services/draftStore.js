import { removePlaceholders } from '../utils/attachmentMarkup';

// Unsent messages, by chat id (ChatPane's `chatId`): what was typed in a conversation's message
// box comes back when you return to it. Only in memory, never stored: encrypted chats' text
// stays off the disk, and closing the tab, window or app (or logging out) forgets them.
// Attachments aren't kept (they're dropped on leaving the conversation, see
// useAttachmentDrafts), so their placeholders are taken out.
const drafts = new Map();

export function getDraft(chatId) {
  return drafts.get(String(chatId)) ?? '';
}

export function saveDraft(chatId, text) {
  const kept = removePlaceholders(text ?? '');
  if (kept.trim()) drafts.set(String(chatId), kept);
  else drafts.delete(String(chatId));
}

export function clearDrafts() {
  drafts.clear();
}
