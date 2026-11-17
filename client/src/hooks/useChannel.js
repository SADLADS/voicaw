import { useEffect, useRef, useState } from 'react';
import { onGuildEvent, setActiveChat, setSideChat } from '../utils/ws-client';
import { isEphemeral, onDismissRequest } from '../utils/botComponents';
import {
  fetchChannelMessages,
  sendChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  markChannelRead,
  fetchChannelPins,
  setChannelMessagePinned,
  setChannelMessageEmbedsSuppressed,
  fetchMessageEditHistory,
} from '../services/guildService';
import { useCatchUp } from './useCatchUp';
import { mergeNewestPage } from '../utils/catchUp';
import { comparePosition, highestId } from '../utils/messageOrder';

// Older history is fetched in pages this size as you scroll up.
export const CHANNEL_PAGE_SIZE = 50;

// Guild messages are plain text; the message list reads `plaintext` (as for decrypted DMs).
export function toChatMessage(row) {
  // A "poll ended" row has no text of its own.
  return { ...row, plaintext: row.system ? null : row.content, parent_plaintext: row.parent_content ?? null, reactions: row.reactions ?? [] };
}

// One guild text channel (or, with `documentId`, one document's replies in a document channel):
// loads and pages its history, sends, edits and deletes, applies live
// changes from the websocket, and keeps the channel marked read while it's shown (`onRead`
// runs after, to refresh unread badges). The same shape as useConversation, for ChatPane.
// A thread is a channel here too; `side` says it's shown beside the active chat (a thread next
// to its channel), not instead of it. Messages a thread started from keep their `thread` current.
export function useChannel({ channelId, documentId = null, side = false, user, onRead }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped by retry() (an error state's Try again): loads it again.
  const [attempt, setAttempt] = useState(0);
  // The channel whose history is loaded (null while loading), so a jump waits for it.
  const [loadedChannelId, setLoadedChannelId] = useState(null);
  // Bumped whenever a message here is pinned or unpinned (the pins list reloads).
  const [pinsVersion, setPinsVersion] = useState(0);
  // Where the unread messages started when the channel opened ({ id }; useConversation's).
  // Not for a document's replies: the channel's unread messages may be under other documents.
  const [firstUnread, setFirstUnread] = useState(null);
  // Looking at older history after a jump (jumpTo): there are newer messages than those shown.
  const [hasNewer, setHasNewer] = useState(false);
  const hasNewerRef = useRef(false);
  const setNewer = (value) => {
    hasNewerRef.current = value;
    setHasNewer(value);
  };

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  // The channel (and document) being shown, so late responses for a previous one are ignored.
  const chatKey = `${channelId}/${documentId ?? ''}`;
  const activeChannelId = useRef(chatKey);
  // Fetch parameters for this chat (a document channel's: which document).
  const pageParams = (params) => (documentId ? { ...params, document: documentId } : params);
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

  // `opening`: the read on opening the channel, which says where its unread messages started.
  const markRead = async (messageId, { opening = false } = {}) => {
    if (!channelId || !Number.isInteger(messageId)) return;
    try {
      const requestedFor = chatKey;
      const first = await markChannelRead(channelId, messageId);
      if (opening && first != null && documentId == null && activeChannelId.current === requestedFor) setFirstUnread({ id: first });
      onReadRef.current?.();
    } catch (err) {
      console.warn('Failed to mark channel as read', err);
    }
  };

  // Load the newest page; the only place history is (re)loaded (older pages are prepended by
  // loadMoreMessages).
  useEffect(() => {
    activeChannelId.current = chatKey;
    loadingOlder.current = false;
    setMessages([]);
    setFirstUnread(null);
    setHasMore(true);
    setNewer(false);
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
        const page = await fetchChannelMessages(channelId, pageParams({ limit: CHANNEL_PAGE_SIZE }));
        if (cancelled) return;
        setMessages(page.map(toChatMessage));
        setHasMore(page.length >= CHANNEL_PAGE_SIZE);
        setLoadedChannelId(channelId);
        // Marked read even when empty, so the badge goes. The highest id, not the last row's:
        // an imported message can be last by time with an id above the live ones.
        markRead(highestId(page) ?? 0, { opening: true });
      } catch (e) {
        if (cancelled) return;
        console.error('Failed to load channel:', e);
        setError(e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, attempt]);

  const loadMoreMessages = async () => {
    if (loadingOlder.current || !hasMore) return;
    const oldest = messagesRef.current.find((m) => Number.isInteger(m.id) && !isEphemeral(m));
    if (!oldest) return;

    loadingOlder.current = true;
    const requestedFor = chatKey;
    try {
      const page = await fetchChannelMessages(channelId, pageParams({ before: oldest.id, limit: CHANNEL_PAGE_SIZE }));
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
    if (hasNewerRef.current) return; // shown when the list reaches the present again
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

  // An ephemeral message goes where its time puts it (it's never in a loaded page).
  function addEphemeral(message) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      const at = prev.findIndex((m) => m.timestamp != null && m.timestamp > message.timestamp);
      return at === -1 ? [...prev, message] : [...prev.slice(0, at), message, ...prev.slice(at)];
    });
  }

  // Dismissing an ephemeral message (its footer, utils/botComponents.js) removes it.
  useEffect(() => onDismissRequest((messageId) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }), []);

  // Same contract as useConversation's sendMessage.
  async function sendMessage({ text, replyTo = null, localAttachments = {}, resolveText, nonce }) {
    const tempId = `temp-${nonce ?? Date.now()}`;
    const tempMessage = {
      id: tempId,
      channel_id: channelId,
      document_id: documentId,
      sender_id: user.id,
      plaintext: text,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
      parent_message_id: replyTo?.id ?? null,
      parent_plaintext: replyTo?.plaintext ?? null,
      parent_system: replyTo?.system ?? null,
      parent_sender_id: replyTo?.sender_id ?? null,
      parent_username: replyTo?.sender_username ?? null,
      parent_webhook_id: replyTo?.webhook_id ?? null,
      parent_webhook_avatar: replyTo?.webhook_avatar ?? null,
      reactions: [],
      localAttachments,
    };
    setMessages((prev) => [...prev, tempMessage]);

    try {
      const finalText = resolveText ? await resolveText() : text;
      if (finalText !== text) updateMessage(tempId, () => ({ plaintext: finalText }));

      const saved = toChatMessage(await sendChannelMessage(channelId, finalText, replyTo?.id ?? null, documentId, nonce));
      setMessages((prev) => {
        // The websocket echo may already have replaced it (then it has the real id).
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== tempId);
        return prev.map((m) => (m.id === tempId ? { ...saved, clientKey: tempId, localAttachments, status: 'sent' } : m));
      });
      return saved;
    } catch (err) {
      console.error('Error sending message:', err);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
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
  // A message's earlier versions (EditHistoryDialog): { versions: [{ plaintext, written_at,
  // edited }], edited_at }.
  async function loadEdits(msg) {
    const { versions, edited_at } = await fetchMessageEditHistory(msg.id);
    return { versions: versions.map((v) => ({ ...v, plaintext: v.content })), edited_at };
  }

  async function loadPins() {
    return (await fetchChannelPins(channelId)).map(toChatMessage);
  }

  async function setPinned(msg, pinned) {
    applyPin(await setChannelMessagePinned(msg.id, pinned));
  }

  // "Remove previews" (the author, or Manage Messages).
  async function suppressEmbeds(msg) {
    const { flags } = await setChannelMessageEmbedsSuppressed(msg.id, true);
    updateMessage(msg.id, () => ({ flags }));
  }

  // Whatever the websocket missed (the phone asleep, a reconnect): the newest page again.
  // Not while looking at older history (jumpTo): the newest page isn't on screen then.
  useCatchUp(async () => {
    const requestedFor = chatKey;
    if (hasNewerRef.current) return;
    const page = (await fetchChannelMessages(channelId, pageParams({ limit: CHANNEL_PAGE_SIZE }))).map(toChatMessage);
    if (activeChannelId.current !== requestedFor || hasNewerRef.current) return;
    const { gap, added } = mergeNewestPage(messagesRef.current, page, CHANNEL_PAGE_SIZE, comparePosition);
    setMessages((prev) => mergeNewestPage(prev, page, CHANNEL_PAGE_SIZE, comparePosition).messages);
    if (gap) setHasMore(true);
    if (added.length) markRead(highestId(page));
  }, loadedChannelId != null && String(loadedChannelId) === String(channelId));

  // Jumping to a message that isn't loaded (search, pins, a reply far back, a link): the page
  // around it replaces the list, which then loads newer pages as you scroll down
  // (`hasNewer`) until it reaches the present again, or Jump to present reloads the newest.
  // New messages meanwhile aren't added (they'd sit after a gap); reaching the present
  // brings them. Resolves once the page is shown (false if the message isn't here).
  async function jumpTo(messageId) {
    const requestedFor = chatKey;
    const page = await fetchChannelMessages(channelId, pageParams({ around: messageId, limit: CHANNEL_PAGE_SIZE }));
    if (activeChannelId.current !== requestedFor) return false;
    const at = page.findIndex((m) => m.id === messageId);
    if (at === -1) return false;
    loadingOlder.current = false;
    setMessages(page.map(toChatMessage));
    setHasMore(at >= Math.ceil(CHANNEL_PAGE_SIZE / 2) - 1);
    setNewer(page.length - at - 1 >= Math.floor(CHANNEL_PAGE_SIZE / 2));
    return true;
  }

  const loadingNewer = useRef(false);
  async function loadNewerMessages() {
    if (loadingNewer.current || !hasNewerRef.current) return;
    const stored = messagesRef.current.filter((m) => Number.isInteger(m.id) && !isEphemeral(m));
    const newest = stored[stored.length - 1];
    if (!newest) return;
    loadingNewer.current = true;
    const requestedFor = chatKey;
    try {
      const page = await fetchChannelMessages(channelId, pageParams({ after: newest.id, limit: CHANNEL_PAGE_SIZE }));
      if (activeChannelId.current !== requestedFor) return;
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = page.map(toChatMessage).filter((m) => !known.has(m.id));
      if (fresh.length) setMessages((prev) => [...prev, ...fresh]);
      if (page.length < CHANNEL_PAGE_SIZE) {
        setNewer(false);
        markRead(highestId(page) ?? newest.id);
      }
    } catch (e) {
      console.error('Failed to load newer messages:', e);
    } finally {
      loadingNewer.current = false;
    }
  }

  // Back to the newest page (Jump to present).
  const jumpToPresent = () => setAttempt((n) => n + 1);

  // The server doesn't push messages here while this device is looking at the channel.
  useEffect(() => {
    if (!channelId) return undefined;
    const set = side ? setSideChat : setActiveChat;
    set(`channel-${channelId}`);
    return () => set(null);
  }, [channelId, side]);

  // Live changes for this channel.
  useEffect(() => {
    if (!channelId || !user?.id) return undefined;
    const id = Number(channelId);
    return onGuildEvent((event) => {
      switch (event.type) {
        case 'guild_message_new':
          // Only this chat's: in a document channel, this document's replies.
          if (event.message.channel_id === id && (event.message.document_id ?? null) === (documentId ?? null)) {
            addIncomingMessage(toChatMessage(event.message));
          }
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
              // A bot's edits (and answers to its buttons) can change its components.
              ...(event.components ? { components: event.components } : {}),
            }));
          }
          break;
        // Link previews the server made after the message was sent or edited (server/linkPreviews.js),
        // or "Remove previews".
        case 'guild_message_embeds':
          if (event.channelId === id) {
            updateMessage(event.messageId, () => ({
              ...(event.link_embeds ? { link_embeds: event.link_embeds } : {}),
              ...(event.flags !== undefined ? { flags: event.flags } : {}),
            }));
          }
          break;
        // A bot's ephemeral reply, only to you (server/interactions.js): kept here only, in time
        // order, until reload or Dismiss.
        case 'guild_ephemeral_message':
          if (event.channelId === id && !documentId) addEphemeral(toChatMessage(event.message));
          break;
        case 'guild_ephemeral_edit':
          if (event.channelId === id) updateMessage(event.message.id, () => toChatMessage(event.message));
          break;
        case 'guild_ephemeral_delete':
          if (event.channelId === id) setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        case 'guild_message_delete':
          if (event.channelId === id) setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        case 'guild_reaction_add': {
          if (event.channelId !== id) break;
          const { id: reactionId, message_id: messageId, user_id: userId, emoji, timestamp } = event.reaction;
          setMessageReactions(messageId, (list) =>
            list.some((r) => r.id === reactionId) ? list : [...list, { id: reactionId, user_id: userId, emoji, timestamp }]
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
        case 'guild_thread_update':
          if (event.thread.parent_id === id) updateMessage(event.thread.starter_message_id, () => ({ thread: event.thread }));
          break;
        case 'guild_thread_delete':
          if (event.channelId === id) {
            setMessages((prev) => prev.map((m) => (m.thread?.id === event.threadId ? { ...m, thread: null } : m)));
          }
          break;
        // A history import added, changed or removed messages here (server/guildImports.js):
        // loaded again, unless you're looking further back (it applies when you come back).
        case 'guild_history_changed':
          if (event.channelId === id && !hasNewerRef.current) setAttempt((n) => n + 1);
          break;
        default:
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, user?.id]);

  return {
    messages,
    firstUnread,
    messagesRef,
    hasMore,
    isLoading,
    error,
    retry: () => setAttempt((n) => n + 1),
    loadedChannelId,
    loadMoreMessages,
    hasNewer,
    loadNewerMessages,
    jumpTo,
    jumpToPresent,
    sendMessage,
    editMessage,
    deleteMessage,
    setMessageReactions,
    pinsVersion,
    loadPins,
    setPinned,
    loadEdits,
    suppressEmbeds,
  };
}
