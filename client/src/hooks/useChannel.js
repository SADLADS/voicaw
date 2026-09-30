import { useEffect, useRef, useState } from 'react';
import { onGuildEvent, setActiveChat } from '../utils/ws-client';
import {
  fetchChannelMessages,
  sendChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  markChannelRead,
  fetchChannelPins,
  setChannelMessagePinned,
} from '../services/guildService';

// Older history is fetched in pages this size as you scroll up.
export const CHANNEL_PAGE_SIZE = 50;

// Guild messages are plain text; the message list reads `plaintext` (as for decrypted DMs).
export function toChatMessage(row) {
  return { ...row, plaintext: row.content, parent_plaintext: row.parent_content ?? null, reactions: row.reactions ?? [] };
}

// One guild text channel: loads and pages its history, sends, edits and deletes, applies live
// changes from the websocket, and keeps the channel marked read while it's shown (`onRead`
// runs after, to refresh unread badges). The same shape as useConversation, for ChatPane.
export function useChannel({ channelId, user, onRead }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // The channel whose history is loaded (null while loading), so a jump waits for it.
  const [loadedChannelId, setLoadedChannelId] = useState(null);
  // Bumped whenever a message here is pinned or unpinned (the pins list reloads).
  const [pinsVersion, setPinsVersion] = useState(0);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  // The channel being shown, so late responses for a previous one are ignored.
  const activeChannelId = useRef(channelId);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const updateMessage = (messageId, update) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...update(m) } : m)));
  };

  const setMessageReactions = (messageId, update) => {
    updateMessage(messageId, (m) => ({ reactions: update(m.reactions ?? []) }));
  };

  const applyPin = ({ messageId, pinned_at: pinnedAt, pinned_by: pinnedBy }) => {
    updateMessage(messageId, () => ({ pinned_at: pinnedAt, pinned_by: pinnedBy }));
    setPinsVersion((n) => n + 1);
  };

  const markRead = async (messageId) => {
    if (!channelId || !Number.isInteger(messageId)) return;
    try {
      await markChannelRead(channelId, messageId);
      onReadRef.current?.();
    } catch (err) {
      console.warn('Failed to mark channel as read', err);
    }
  };

  // Load the newest page; the only place history is (re)loaded (older pages are prepended by
  // loadMoreMessages).
  useEffect(() => {
    activeChannelId.current = channelId;
    loadingOlder.current = false;
    setMessages([]);
    setHasMore(true);
    setError(null);
    setLoadedChannelId(null);
    if (!channelId) {
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const page = await fetchChannelMessages(channelId, { limit: CHANNEL_PAGE_SIZE });
        if (cancelled) return;
        setMessages(page.map(toChatMessage));
        setHasMore(page.length >= CHANNEL_PAGE_SIZE);
        setLoadedChannelId(channelId);
        const newest = page[page.length - 1];
        // Marked read even when empty, so the badge goes.
        markRead(newest ? newest.id : 0);
      } catch (e) {
        if (cancelled) return;
        console.error('Failed to load channel:', e);
        setError(e.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const loadMoreMessages = async () => {
    if (loadingOlder.current || !hasMore) return;
    const oldest = messagesRef.current.find((m) => Number.isInteger(m.id));
    if (!oldest) return;

    loadingOlder.current = true;
    const requestedFor = channelId;
    try {
      const page = await fetchChannelMessages(requestedFor, { before: oldest.id, limit: CHANNEL_PAGE_SIZE });
      if (activeChannelId.current !== requestedFor) return;
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = page.map(toChatMessage).filter((m) => !known.has(m.id));
      if (fresh.length > 0) setMessages((prev) => [...fresh, ...prev]);
      setHasMore(page.length >= CHANNEL_PAGE_SIZE);
    } catch (e) {
      // Keep the channel on screen; scrolling back to the top retries.
      console.error('Failed to load older messages:', e);
    } finally {
      if (activeChannelId.current === requestedFor) loadingOlder.current = false;
    }
  };

  // A new message from the websocket. Our own echo replaces the matching pending message
  // (or is dropped, if the send's response already did).
  function addIncomingMessage(message) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      const pendingIndex = prev.findIndex(
        (m) => m.status === 'pending' && m.sender_id === message.sender_id && m.plaintext === message.plaintext
      );
      if (pendingIndex !== -1) {
        const updated = [...prev];
        updated[pendingIndex] = { ...message, clientKey: prev[pendingIndex].clientKey ?? prev[pendingIndex].id };
        return updated;
      }
      return [...prev, message];
    });
    if (message.sender_id !== user.id) markRead(message.id);
  }

  // Same contract as useConversation's sendMessage.
  async function sendMessage({ text, replyTo = null, localAttachments = {}, resolveText }) {
    const tempId = `temp-${Date.now()}`;
    const tempMessage = {
      id: tempId,
      channel_id: channelId,
      sender_id: user.id,
      plaintext: text,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
      parent_message_id: replyTo?.id ?? null,
      parent_plaintext: replyTo?.plaintext ?? null,
      parent_sender_id: replyTo?.sender_id ?? null,
      parent_username: replyTo?.sender_username ?? null,
      reactions: [],
      localAttachments,
    };
    setMessages((prev) => [...prev, tempMessage]);

    try {
      const finalText = resolveText ? await resolveText() : text;
      if (finalText !== text) updateMessage(tempId, () => ({ plaintext: finalText }));

      const saved = toChatMessage(await sendChannelMessage(channelId, finalText, replyTo?.id ?? null));
      setMessages((prev) => {
        // The websocket echo may already have replaced it (then it has the real id).
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== tempId);
        return prev.map((m) => (m.id === tempId ? { ...saved, clientKey: tempId, localAttachments, status: 'sent' } : m));
      });
    } catch (err) {
      console.error('Error sending message:', err);
      updateMessage(tempId, () => ({ status: 'failed' }));
      throw err;
    }
  }

  async function editMessage(messageId, text) {
    await editChannelMessage(messageId, text);
    updateMessage(messageId, () => ({ plaintext: text, content: text, edited: 1 }));
  }

  async function deleteMessage(messageId) {
    await deleteChannelMessage(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }

  // The channel's pinned messages, most recently pinned first.
  async function loadPins() {
    return (await fetchChannelPins(channelId)).map(toChatMessage);
  }

  async function setPinned(msg, pinned) {
    applyPin(await setChannelMessagePinned(msg.id, pinned));
  }

  // The server doesn't push messages here while this device is looking at the channel.
  useEffect(() => {
    if (!channelId) return undefined;
    setActiveChat(`channel-${channelId}`);
    return () => setActiveChat(null);
  }, [channelId]);

  // Live changes for this channel.
  useEffect(() => {
    if (!channelId || !user?.id) return undefined;
    const id = Number(channelId);
    return onGuildEvent((event) => {
      switch (event.type) {
        case 'guild_message_new':
          if (event.message.channel_id === id) addIncomingMessage(toChatMessage(event.message));
          break;
        case 'guild_message_edit':
          if (event.channelId === id) {
            updateMessage(event.messageId, () => ({
              plaintext: event.content,
              content: event.content,
              edited: 1,
              mention_everyone: event.mention_everyone,
              mention_roles: event.mention_roles,
              // A webhook's edits can change these too.
              ...(event.embeds ? { embeds: event.embeds } : {}),
              ...(event.attachments ? { attachments: event.attachments } : {}),
              ...(event.flags !== undefined ? { flags: event.flags } : {}),
            }));
          }
          break;
        case 'guild_message_delete':
          if (event.channelId === id) setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        case 'guild_reaction_add': {
          if (event.channelId !== id) break;
          const { id: reactionId, message_id: messageId, user_id: userId, emoji } = event.reaction;
          setMessageReactions(messageId, (list) =>
            list.some((r) => r.id === reactionId) ? list : [...list, { id: reactionId, user_id: userId, emoji }]
          );
          break;
        }
        case 'guild_message_pin':
          if (event.channelId === id) applyPin(event);
          break;
        case 'guild_reaction_remove':
          if (event.channelId === id) {
            setMessageReactions(event.messageId, (list) => list.filter((r) => r.id !== event.reactionId));
          }
          break;
        default:
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, user?.id]);

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
    setMessageReactions,
    pinsVersion,
    loadPins,
    setPinned,
  };
}
