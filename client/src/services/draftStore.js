import { placeholderIdFromUrl } from '../utils/attachmentMarkup';

// Unsent messages, by chat id (ChatPane's `chatId`): what was typed in a conversation's message
// box, and the files attached to it, come back when you return to it. Only in memory, never
// stored: encrypted chats' text and files stay off the disk, and closing the tab, window or app
// (or logging out) forgets them.
const drafts = new Map();
// chat id -> { drafts, mediaInfo }: useAttachmentDrafts' attachments while it shows another chat.
const attachments = new Map();

const EMBED_RE = /!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

// The text, without placeholders of attachments that aren't there any more (`keptIds`: the
// draft ids that are).
export function getDraft(chatId, keptIds = new Set()) {
  const text = drafts.get(String(chatId)) ?? '';
  return text.replace(EMBED_RE, (match, alt, url) => {
    const id = placeholderIdFromUrl(url);
    return id !== null && !keptIds.has(id) ? '' : match;
  });
}

export function saveDraft(chatId, text) {
  if (text?.trim()) drafts.set(String(chatId), text);
  else drafts.delete(String(chatId));
}

// Bumped by clearDrafts: attachments from before it (a composer only going away after the
// logout) aren't kept for the next account.
let generation = 0;
// Attachment draft ids, unique while the app is open (kept drafts come back beside new ones,
// in any composer).
let nextDraftId = 1;

export function draftGeneration() {
  return generation;
}

export function newDraftId() {
  return nextDraftId++;
}

// The attachments of a chat being left (useAttachmentDrafts, which opened it in `since`, a
// draftGeneration()), until it's opened again.
export function keepAttachments(chatId, kept, since = generation) {
  if (since !== generation) {
    kept.drafts.forEach((d) => URL.revokeObjectURL(d.previewUrl));
    return;
  }
  if (kept.drafts.length) attachments.set(String(chatId), kept);
  else attachments.delete(String(chatId));
}

// Takes them back: { drafts, mediaInfo }, or null.
export function takeAttachments(chatId) {
  const kept = attachments.get(String(chatId)) ?? null;
  attachments.delete(String(chatId));
  return kept;
}

export function clearDrafts() {
  drafts.clear();
  attachments.forEach((kept) => kept.drafts.forEach((d) => URL.revokeObjectURL(d.previewUrl)));
  attachments.clear();
  generation++;
  nextDraftId = 1;
}
