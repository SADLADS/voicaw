import { useEffect, useRef, useState } from 'react';
import { onBotDmEvent, setActiveChat } from '../utils/ws-client';
import {
  deleteBotDmMessage, editBotDmMessage, fetchBotDmMessages, markBotDmRead, sendBotDmMessage,
} from '../services/botDmService';

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
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  const activeDm = useRef(dmId);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const updateMessage = (messageId, update) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...update(m) } : m)));
  };

  const markRead = async (messageId) => {
    if (!dmId || !Number.isInteger(messageId)) return;
    try {
      await markBotDmRead(dmId, messageId);
      onReadRef.current?.();
    } catch (err) {
      console.warn('Failed to mark the conversation as read', err);
    }
  };

  useEffect(() => {
    activeDm.current = dmId;
    loadingOlder.current = false;
    setMessages([]);
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
        markRead(newest ? newest.id : 0);
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
  async function sendMessage({ text, resolveText }) {
    const tempId = `temp-${Date.now()}`;
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
      const saved = await sendBotDmMessage(dmId, finalText);
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== tempId);
        return prev.map((m) => (m.id === tempId ? { ...saved, clientKey: tempId, status: 'sent' } : m));
      });
      return saved;
    } catch (err) {
      updateMessage(tempId, () => ({ status: 'failed' }));
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
