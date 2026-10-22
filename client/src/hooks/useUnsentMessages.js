import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { addUnsent, getUnsent, removeUnsent, subscribeUnsent } from '../services/unsentStore';

let sendOrder = 0;

// Sending in a chat (ChatPane), keeping what couldn't be sent. `sendMessage` is the chat hook's
// (useConversation's contract: it shows the message as pending, and throws if it couldn't send,
// taking it out again). A message that failed is kept in unsentStore under `chatId` and shown at
// the end of the chat (`rows`, status 'failed') until it's retried or deleted, also after leaving
// the chat and coming back.
//
// Every message gets a random nonce, the same on every retry: the server saves it once
// (server/sendNonces.js), so a retry after an answer was lost on the way (the message did
// arrive) only gets the saved message back. Attachments already uploaded aren't uploaded again.
// Such a message usually turns up by itself too (our own websocket echo, or the chat loading
// again once the connection is back): a message of ours with the same text, newer than
// everything the chat had when it was sent, means it arrived (or was sent again by hand), and
// it stops being unsent. `messages` are the chat hook's.
export function useUnsentMessages({ chatId, user, sendMessage, messages }) {
  const stored = useSyncExternalStore(subscribeUnsent, () => getUnsent(chatId));
  const latestSend = useRef(sendMessage);
  latestSend.current = sendMessage;
  const latestMessages = useRef(messages);
  latestMessages.current = messages;

  // Right after `chatId` changes, `messages` are still the last chat's until the chat hook
  // replaces them: they don't count until then.
  const [shownWhenOpened, setShownWhenOpened] = useState({ chatId, messages });
  if (shownWhenOpened.chatId !== chatId) setShownWhenOpened({ chatId, messages });
  const ours = shownWhenOpened.chatId === chatId && messages !== shownWhenOpened.messages;

  const arrived = useCallback((entry) => ours && messages.some((m) => (
    m.sender_id === user?.id && Number.isInteger(m.id) && m.id > entry.afterId && m.plaintext === entry.sentText()
  )), [ours, messages, user?.id]);
  const entries = useMemo(() => stored.filter((entry) => !arrived(entry)), [stored, arrived]);
  useEffect(() => {
    stored.filter(arrived).forEach((entry) => removeUnsent(chatId, entry.id));
  }, [stored, arrived, chatId]);

  // `onSent(saved)` runs once it's sent (on a retry too): a poll's timer.
  const attempt = useCallback(async (key, entry) => {
    let saved;
    try {
      saved = await latestSend.current({ ...entry.params, nonce: entry.nonce });
    } catch (err) {
      addUnsent(key, entry);
      throw err;
    }
    await entry.onSent?.(saved);
    return saved;
  }, []);

  // Sends ({ text, replyTo, localAttachments, resolveText }, as sendMessage takes them).
  // Resolves to the saved message; throws if it couldn't (it's then kept as unsent).
  const send = useCallback((params, { onSent } = {}) => {
    const nonce = crypto.randomUUID();
    let resolved = null;
    const resolveText = params.resolveText && (async () => {
      resolved ??= await params.resolveText();
      return resolved;
    });
    const entry = {
      id: `unsent-${nonce}`,
      nonce,
      order: ++sendOrder,
      timestamp: Math.floor(Date.now() / 1000),
      // Ids only grow: anything saved after this was sent has a higher one.
      afterId: Math.max(0, ...latestMessages.current.map((m) => m.id).filter(Number.isInteger)),
      // The text as sent: with its attachments' links once they're uploaded.
      sentText: () => resolved ?? params.text,
      params: { ...params, resolveText },
      onSent,
    };
    return attempt(chatId, entry);
  }, [attempt, chatId]);

  // Sends it again (throws if that fails too; it's kept again).
  const retry = useCallback((id) => {
    const entry = getUnsent(chatId).find((e) => e.id === id);
    if (!entry || !removeUnsent(chatId, id)) return Promise.resolve(null);
    return attempt(chatId, entry);
  }, [attempt, chatId]);

  const discard = useCallback((id) => {
    removeUnsent(chatId, id);
  }, [chatId]);

  const rows = useMemo(() => entries.map(({ id, timestamp, params: { text, replyTo, localAttachments } }) => ({
    id,
    clientKey: id,
    sender_id: user?.id,
    sender_username: user?.username,
    plaintext: text,
    status: 'failed',
    timestamp,
    parent_message_id: replyTo?.id ?? null,
    parent_plaintext: replyTo?.plaintext ?? null,
    parent_sender_id: replyTo?.sender_id ?? null,
    parent_username: replyTo?.sender_username ?? null,
    reactions: [],
    localAttachments: localAttachments ?? {},
  })), [entries, user?.id, user?.username]);

  return { rows, send, retry, discard };
}
