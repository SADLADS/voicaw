import { shareOrigin } from './guildDisplay';

// Open Image in the desktop app (imageActions.js) opens an encrypted attachment in the browser.
// The picture itself can't go there: its decrypted copy is a blob: URL only this page can read,
// and its own URL carries its key, so a link with it would show it to anyone who saw the link
// (the browser's history included). The browser gets where the picture is instead: the page it's
// on, plus `in` (the chat: ChatPane's `chatId`), `message`, `image` (the file's name in the object
// store, no key) and `as` (the account it's in). Logged out, the web app asks to log in first
// (App's routes); logged in as someone else, to switch (ImageLinkAccount). Then the chat finds
// the message with its own keys and opens the picture in the viewer (hooks/useImageLink.js).

const PARAMS = ['in', 'message', 'image', 'as'];

// Where the picture on `el` is: its chat (MessageList's `data-chat-id`) and message, or null
// outside a chat's messages (search results, the pins list, a document).
export function placeOf(el) {
  const chat = el.closest('[data-chat-id]');
  const row = el.closest('[data-msg-id]');
  if (!chat || !row) return null;
  return { chatId: chat.dataset.chatId, messageId: row.dataset.msgId };
}

// The object store's name for an attachment's file ("<uuid>.bin"), from its URL.
export function fileNameOf(src) {
  try {
    return new URL(src).pathname.split('/').pop() || null;
  } catch {
    return null;
  }
}

// The web app's link to `item` (a gallery item with `meta` and `place`) for account `userId`,
// opened from the page at `location`; null when it isn't an encrypted attachment in a chat.
export function browserImageLink(item, userId, location = window.location) {
  const file = item.meta ? fileNameOf(item.src) : null;
  if (!file || !item.place || userId == null) return null;
  const params = new URLSearchParams(location.search);
  PARAMS.forEach((name) => params.delete(name));
  params.set('in', item.place.chatId);
  params.set('message', item.place.messageId);
  params.set('image', file);
  params.set('as', String(userId));
  return `${shareOrigin()}${location.pathname}?${params}`;
}

// The picture a page's query (`location.search`) asks for: { chatId, messageId, file, as }, or
// null.
export function imageLinkIn(search) {
  const params = new URLSearchParams(search);
  const [chatId, messageId, file, as] = PARAMS.map((name) => params.get(name));
  if (!chatId || !file || !/^\d+$/.test(messageId ?? '') || !/^\d+$/.test(as ?? '')) return null;
  return { chatId, messageId, file, as };
}

// The query without the picture's parameters (once it's been opened, or not wanted).
export function withoutImageLink(search) {
  const params = new URLSearchParams(search);
  PARAMS.forEach((name) => params.delete(name));
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
