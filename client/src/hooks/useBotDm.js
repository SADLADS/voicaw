import { useEffect, useRef, useState } from 'react';
import { onBotDmEvent, setActiveChat } from '../utils/ws-client';
import {
  deleteBotDmMessage, editBotDmMessage, fetchBotDmMessages, markBotDmRead, sendBotDmMessage,
} from '../services/botDmService';
import { useCatchUp } from './useCatchUp';
import { mergeNewestPage } from '../utils/catchUp';

export const BOT_DM_PAGE_SIZE = 50;

// One conversation with a bot (server/botDms.js): loads and pages its history, sends, edits and
// deletes your messages, applies live changes, and keeps it read while it's shown. The same
// shape as useChannel, for ChatPane. Plain text: these aren't end-to-end encrypted.
export function useBotDm({ dmId, user, onRead }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadedChannelId, setLoadedChannelId] = useState(null);
  // Where the unread messages started when the conversation opened ({ id }; useConversation's).
  const [firstUnread, setFirstUnread] = useState(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  const activeDm = useRef(dmId);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const updateMessage = (messageId, update) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...update(m) } : m)));
  };

  // `opening`: the read on opening the conversation, which says where its unread messages started.
  const markRead = async (messageId, { opening = false } = {}) => {
    if (!dmId || !Number.isInteger(messageId)) return;
    try {
      const requestedFor = dmId;
      const first = await markBotDmRead(dmId, messageId);
      if (opening && first != null && activeDm.current === requestedFor) setFirstUnread({ id: first });
      onReadRef.current?.();
    } catch (err) {
      console.warn('Failed to mark the conversation as read', err);
    }
  };

  useEffect(() => {
    activeDm.current = dmId;
    loadingOlder.current = false;
    setMessages([]);
    setFirstUnread(null);
    setHasMore(true);
    setError(null);
    setLoadedChannelId(null);
    if (!dmId) {
      setIsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const page = await fetchBotDmMessages(dmId, { limit: BOT_DM_PAGE_SIZE });
        if (cancelled) return;
        setMessages(page);
        setHasMore(page.length >= BOT_DM_PAGE_SIZE);
        setLoadedChannelId(dmId);
        const newest = page[page.length - 1];
        markRead(newest ? newest.id : 0, { opening: true });
      } catch (e) {
        if (cancelled) return;
        setError(e.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId]);

  const loadMoreMessages = async () => {
    if (loadingOlder.current || !hasMore) return;
    const oldest = messagesRef.current.find((m) => Number.isInteger(m.id));
    if (!oldest) return;
    loadingOlder.current = true;
    const requestedFor = dmId;
    try {
      const page = await fetchBotDmMessages(dmId, { before: oldest.id, limit: BOT_DM_PAGE_SIZE });
      if (activeDm.current !== requestedFor) return;
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = page.filter((m) => !known.has(m.id));
      if (fresh.length > 0) setMessages((prev) => [...fresh, ...prev]);
      setHasMore(page.length >= BOT_DM_PAGE_SIZE);
    } catch (e) {
      console.error('Failed to load older messages:', e);
    } finally {
      if (activeDm.current === requestedFor) loadingOlder.current = false;
    }
  };

  // Same contract as useConversation's sendMessage. Plain text only (no files, polls or replies).
  async function sendMessage({ text, resolveText, nonce }) {
    const tempId = `temp-${nonce ?? Date.now()}`;
    setMessages((prev) => [...prev, {
      id: tempId,
      dm_id: dmId,
      sender_id: user.id,
      sender_username: user.username,
      plaintext: text,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      reactions: [],
    }]);
    try {
      const finalText = resolveText ? await resolveText() : text;
      const saved = await sendBotDmMessage(dmId, finalText, nonce);
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== tempId);
        return prev.map((m) => (m.id === tempId ? { ...saved, clientKey: tempId, status: 'sent' } : m));
      });
      return saved;
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      throw err;
    }
  }

  async function editMessage(messageId, text) {
    await editBotDmMessage(dmId, messageId, text);
    updateMessage(messageId, () => ({ plaintext: text, content: text, edited: 1 }));
  }

  async function deleteMessage(messageId) {
    await deleteBotDmMessage(dmId, messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }

  // Whatever the websocket missed (the phone asleep, a reconnect): the newest page again.
  useCatchUp(async () => {
    const requestedFor = dmId;
    const page = await fetchBotDmMessages(requestedFor, { limit: BOT_DM_PAGE_SIZE });
    if (activeDm.current !== requestedFor) return;
    const { gap, added } = mergeNewestPage(messagesRef.current, page, BOT_DM_PAGE_SIZE);
    setMessages((prev) => mergeNewestPage(prev, page, BOT_DM_PAGE_SIZE).messages);
    if (gap) setHasMore(true);
    if (added.length) markRead(page[page.length - 1].id);
  }, loadedChannelId === dmId && dmId != null);

  // The server doesn't push for this conversation while it's on screen.
  useEffect(() => {
    if (!dmId) return undefined;
    setActiveChat(`bot-dm-${dmId}`);
    return () => setActiveChat(null);
  }, [dmId]);

  useEffect(() => {
    if (!dmId || !user?.id) return undefined;
    return onBotDmEvent((event) => {
      if (event.dmId !== dmId) return;
      switch (event.type) {
        case 'bot_dm_message_new': {
          const { message } = event;
          setMessages((prev) => {
            if (prev.some((m) => m.id === message.id)) return prev;
            const pending = prev.findIndex((m) => m.status === 'pending' && m.sender_id === message.sender_id && m.plaintext === message.plaintext);
            if (pending !== -1) {
              const updated = [...prev];
              updated[pending] = { ...message, clientKey: prev[pending].id };
              return updated;
            }
            return [...prev, message];
          });
          if (message.sender_id !== user.id) markRead(message.id);
          break;
        }
        case 'bot_dm_message_edit':
          updateMessage(event.message.id, () => event.message);
          break;
        case 'bot_dm_message_delete':
          setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        default:
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId, user?.id]);

  return {
    messages,
    firstUnread,
    messagesRef,
    hasMore,
    isLoading,
    error,
    loadedChannelId,
    loadMoreMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    setMessageReactions: () => {},
    pinsVersion: 0,
    loadPins: async () => [],
    setPinned: async () => {},
  };
}
