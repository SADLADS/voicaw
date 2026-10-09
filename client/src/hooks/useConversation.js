import { useEffect, useRef, useState } from 'react';
import { onNewDm, onDeleteDm, onEditDm, onReactionAdd, onReactionRemove, onDmPin, onDmLinkPreviews, setActiveChat } from '../utils/ws-client';
import { uploadNamesIn } from '../utils/attachmentMarkup';
import {
  fetchMessagesForUser,
  sendMessageToUser,
  markMessagesRead,
  editMessage as saveEditedMessage,
  deleteMessage as deleteMessageOnServer,
  fetchPins,
  setMessagePinned,
  setLinkPreviews,
  fetchEditHistory,
} from '../services/dmService';
import {
  encryptMessage,
  decryptMessage,
  decryptMessageRow,
  decryptMessagesBatch,
  decryptReaction,
  deriveConversationKey,
  deriveNotesKey,
  dmContext,
  reactionContext,
} from '../services/encryptionService';
import { loadEncryptionKey, loadOwnPublicKeys } from '../services/keyStore';
import { checkContactKeys, acceptContactKeys } from '../services/contactKeys';
import { dmPreviewsContext, openDmPreviews, sealDmPreviews } from '../services/linkPreviewCrypto';
import { previewsFor } from '../services/linkPreviewService';
import { t } from '../i18n';

// Older history is fetched in pages this size as you scroll up.
export const PAGE_SIZE = 50;

// A decrypted row with its link previews opened (`link_embeds`, drawn as a guild's are; see
// services/linkPreviewCrypto.js), when its sender's app made some.
async function withLinkPreviews(row, key) {
  if (!row.link_previews || row.plaintext == null) return row;
  const context = dmPreviewsContext(row.id, row.sender_id, row.recipient_id);
  return { ...row, link_embeds: await openDmPreviews(row.link_previews, row.content, row.plaintext, key, context) };
}

const decryptRows = async (rows, key) => Promise.all((await decryptMessagesBatch(rows, key)).map((row) => withLinkPreviews(row, key)));

// One DM conversation (with `chatUser`): checks their keys, loads and pages the history,
// sends, edits and deletes, and applies live changes from the websocket. `onRead` runs after
// the conversation is marked read (to refresh unread badges).
//
// Messages are the server's rows plus `plaintext`, `parent_plaintext` and decrypted
// `reactions` ([{ id, user_id, emoji }]); `pinned_at` / `pinned_by` when it's pinned
// (`loadPins`, `setPinned`, `pinsVersion`: bumped on every pin change here). A message being sent has a temporary id and
// `status: 'pending'` (then 'sent' or 'failed'); `clientKey` keeps its list key stable once
// the real id arrives. `firstUnread` ({ id }, or null) is the oldest message that was unread
// when the chat opened (from marking it read), where the "New" divider goes (useNewDivider).
//
// `notes`: your notes, a DM to yourself (`chatUser` is you). Encrypted with a key only your
// own key pair derives (deriveNotesKey), from this device's copy of your public key; never
// unread.
export function useConversation({ id, user, chatUser, onRead, notes = false }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sharedKey, setSharedKey] = useState(null);
  // Result of checking the contact's keys (see contactKeys): null while unknown, then
  // 'trusted' | 'verified' | 'changed' | 'invalid'.
  const [keyStatus, setKeyStatus] = useState(null);
  // Bumped to re-run the conversation load (e.g. after accepting a changed key).
  const [keyCheck, setKeyCheck] = useState(0);
  // Bumped whenever a message here is pinned or unpinned (the pins list reloads).
  const [pinsVersion, setPinsVersion] = useState(0);
  const [firstUnread, setFirstUnread] = useState(null);

  // Always the current render's messages, for handlers that run later.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingOlder = useRef(false);
  // The conversation currently being shown, so late responses for a previous one are ignored.
  const activeChatId = useRef(id);

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

  // `opening`: the read on opening the chat, which says where its unread messages started.
  const markRead = async ({ opening = false } = {}) => {
    try {
      if (!chatUser || notes) return;
      const chatId = id;
      const first = await markMessagesRead(chatUser.id);
      if (opening && first != null && activeChatId.current === chatId) setFirstUnread({ id: first });
      onRead?.();
    } catch (err) {
      console.warn('Failed to mark messages as read', err);
    }
  };

  // Tell the server which chat is on screen (no push notifications for it).
  useEffect(() => {
    setActiveChat(id ?? null);
    return () => setActiveChat(null);
  }, [id]);

  // Load a conversation: check the contact's keys, derive the conversation key, then fetch
  // the newest page. This is the only place history is (re)loaded; older pages are only
  // ever prepended by loadMoreMessages.
  useEffect(() => {
    activeChatId.current = id;
    loadingOlder.current = false;
    setMessages([]);
    setHasMore(true);
    setError(null);
    setSharedKey(null);
    setKeyStatus(null);

    if (!id || !chatUser || !user?.id) {
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        // Never use a key straight from the server: only one that's validly signed and
        // matches what this device has seen for this person before.
        let key;
        if (notes) {
          const [myKey, own] = await Promise.all([loadEncryptionKey(), loadOwnPublicKeys()]);
          if (!myKey || !own?.encryptionKey) throw new Error(t('chat.noKeys'));
          if (cancelled) return;
          setKeyStatus('trusted');
          key = await deriveNotesKey(myKey, own.encryptionKey);
        } else {
          const check = await checkContactKeys(user.id, chatUser);
          if (cancelled) return;
          setKeyStatus(check.status);
          if (!check.encryptionKey) return;

          const myKey = await loadEncryptionKey();
          if (!myKey) throw new Error(t('chat.noKeys'));
          key = await deriveConversationKey(myKey, check.encryptionKey);
        }

        const page = await fetchMessagesForUser(id, { limit: PAGE_SIZE });
        const decrypted = await decryptRows(page, key);
        if (cancelled) return;

        setSharedKey(key);
        setMessages(decrypted);
        setHasMore(page.length > 0);
      } catch (e) {
        if (cancelled) return;
        console.error('Failed to load chat data:', e);
        setError(e.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the contact's keys rather than the chatUser object, which Layout replaces on
    // every user-list fetch; reloading then would reset the conversation (and scroll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id, chatUser?.identity_key, chatUser?.encryption_key, chatUser?.encryption_key_signature, keyCheck, notes]);

  const acceptChangedKey = async () => {
    await acceptContactKeys(user.id, chatUser);
    setKeyCheck((n) => n + 1);
  };

  useEffect(() => {
    setFirstUnread(null);
    if (chatUser?.id) markRead({ opening: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatUser?.id]);

  const loadMoreMessages = async () => {
    // The list can ask again (every scroll event near the top) before this page arrives.
    if (loadingOlder.current || !sharedKey) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    loadingOlder.current = true;
    const chatId = id;
    try {
      const page = await fetchMessagesForUser(chatId, { before: oldest.id, limit: PAGE_SIZE });
      const decrypted = await decryptRows(page, sharedKey);
      if (activeChatId.current !== chatId) return;

      // Skip anything already shown (e.g. overlapping pages), which would otherwise
      // render twice under the same key.
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = decrypted.filter((m) => !known.has(m.id));
      if (fresh.length > 0) setMessages((prev) => [...fresh, ...prev]);
      setHasMore(page.length > 0);
    } catch (e) {
      // Keep the conversation on screen; scrolling back to the top retries.
      console.error('Failed to load older messages:', e);
    } finally {
      if (activeChatId.current === chatId) loadingOlder.current = false;
    }
  };

  // A message from the websocket (already decrypted): ours or theirs in this conversation.
  // Our own echo replaces the matching pending message instead of adding a second copy.
  function addIncomingMessage(message) {
    const chatUserId = String(chatUser.id);
    const myId = String(user.id);
    const sender = String(message.sender_id);
    const recipient = String(message.recipient_id);
    // Checked both ways: in your notes, the chat user is you too.
    const fromChatUser = sender === chatUserId && recipient === myId;
    const fromMeToChatUser = sender === myId && recipient === chatUserId;
    if (!fromChatUser && !fromMeToChatUser) return; // another conversation (Layout badges it)

    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;

      const pendingIndex = prev.findIndex(
        (m) =>
          m.status === 'pending' &&
          m.sender_id === message.sender_id &&
          m.recipient_id === message.recipient_id &&
          m.plaintext === message.plaintext
      );
      if (pendingIndex !== -1) {
        const updated = [...prev];
        updated[pendingIndex] = { ...message, clientKey: prev[pendingIndex].clientKey ?? prev[pendingIndex].id };
        return updated;
      }
      return [...prev, message];
    });
    if (fromChatUser) markRead();
  }

  // Sends `text` (replying to `replyTo`, a message, if given). It shows at once as pending;
  // `resolveText` (async) can turn it into the final text first, e.g. by uploading the
  // attachments it references, whose local copies `localAttachments` shows meanwhile.
  // Resolves to the saved message; throws if sending failed (the message stays, marked failed).
  async function sendMessage({ text, replyTo = null, localAttachments = {}, resolveText }) {
    const tempId = `temp-${Date.now()}`;
    const tempMessage = {
      id: tempId,
      sender_id: user.id,
      recipient_id: chatUser.id,
      plaintext: text,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      sender_username: user.username,
      parent_message_id: replyTo?.id ?? null,
      parent_plaintext: replyTo?.plaintext ?? null,
      localAttachments,
    };
    setMessages((prev) => [...prev, tempMessage]);

    try {
      const finalText = resolveText ? await resolveText() : text;
      if (finalText !== text) {
        // Swap the real text in before sending: our own websocket echo of this message is
        // matched to the pending one by plaintext.
        updateMessage(tempId, () => ({ plaintext: finalText }));
      }

      const encrypted = await encryptMessage(finalText, sharedKey, dmContext(user.id, chatUser.id));
      const saved = await sendMessageToUser(chatUser.id, encrypted, replyTo?.id ?? null, uploadNamesIn(finalText));

      updateMessage(tempId, () => ({
        ...saved,
        clientKey: tempId,
        plaintext: finalText,
        status: 'sent',
        timestamp: saved.timestamp || tempMessage.timestamp,
        parent_plaintext: tempMessage.parent_plaintext,
      }));
      setError(null);
      attachLinkPreviews(saved.id, saved.content, finalText);
      return saved;
    } catch (err) {
      console.error('Error sending message:', err);
      updateMessage(tempId, () => ({ status: 'failed' }));
      throw err;
    }
  }

  async function editMessage(messageId, text) {
    const encrypted = await encryptMessage(text, sharedKey, dmContext(user.id, chatUser.id));
    await saveEditedMessage(messageId, encrypted, uploadNamesIn(text));
    // An edit clears the previews (the server too); this device makes them again.
    updateMessage(messageId, () => ({ plaintext: text, content: encrypted, link_embeds: null }));
    attachLinkPreviews(messageId, encrypted, text);
  }

  // Makes and stores the link previews for this device's message (stored as `content`), if it
  // can (services/linkPreviewService.js). Not awaited: the message is already sent, and its
  // previews follow, as a guild's do.
  async function attachLinkPreviews(messageId, content, text) {
    try {
      const embeds = await previewsFor(text);
      if (!embeds.length) return;
      const context = dmPreviewsContext(messageId, user.id, chatUser.id);
      const envelope = await sealDmPreviews(embeds, content, sharedKey, context);
      if (!envelope) return;
      await setLinkPreviews(messageId, envelope);
      const linkEmbeds = await openDmPreviews(envelope, content, text, sharedKey, context);
      updateMessage(messageId, (m) => (m.content === content ? { link_embeds: linkEmbeds } : {}));
    } catch (err) {
      console.warn('Could not add link previews', err?.message);
    }
  }

  async function deleteMessage(messageId) {
    await deleteMessageOnServer(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }

  // The conversation's pinned messages, decrypted, most recently pinned first.
  async function loadPins() {
    if (!sharedKey) return [];
    return decryptRows(await fetchPins(chatUser.id), sharedKey);
  }

  // A message's earlier versions (EditHistoryDialog), decrypted: { versions: [{ plaintext
  // (null if it can't be read), written_at, edited }], edited_at }.
  async function loadEdits(msg) {
    const { versions, edited_at } = await fetchEditHistory(msg.id);
    const context = dmContext(msg.sender_id, msg.recipient_id);
    const open = (content) => decryptMessage(content, sharedKey, context).catch(() => null);
    return { versions: await Promise.all(versions.map(async (v) => ({ ...v, plaintext: await open(v.content) }))), edited_at };
  }

  async function setPinned(msg, pinned) {
    applyPin(await setMessagePinned(msg.id, pinned));
  }

  // Live changes from the websocket.
  useEffect(() => {
    if (!user?.id || !chatUser?.id || !sharedKey) return undefined;

    const unsubscribeNew = onNewDm(async (message) => {
      addIncomingMessage(await withLinkPreviews(await decryptMessageRow({ ...message, reactions: [] }, sharedKey), sharedKey));
    });

    const unsubscribeDelete = onDeleteDm(({ messageId }) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    });

    const unsubscribeEdit = onEditDm(async ({ messageId, content }) => {
      const original = messagesRef.current.find((m) => m.id === messageId);
      if (!original) return;
      try {
        const plaintext = await decryptMessage(content, sharedKey, dmContext(original.sender_id, original.recipient_id));
        updateMessage(messageId, () => ({ plaintext, content, edited: 1, link_embeds: null }));
      } catch (err) {
        console.error('Failed to decrypt edited message', err);
      }
    });

    const unsubscribeReactionAdd = onReactionAdd(async (reaction) => {
      const msg = messagesRef.current.find((m) => m.id === reaction.message_id);
      if (!msg) return; // another conversation, or a message not loaded here
      try {
        const emoji = await decryptReaction(
          reaction.content, sharedKey, reactionContext(msg.id, reaction.user_id, msg.sender_id, msg.recipient_id)
        );
        setMessageReactions(msg.id, (list) =>
          list.some((r) => r.id === reaction.id) ? list : [...list, { id: reaction.id, user_id: reaction.user_id, emoji, timestamp: reaction.timestamp }]
        );
      } catch (err) {
        console.warn('Failed to decrypt reaction', reaction.id, err);
      }
    });

    const unsubscribeReactionRemove = onReactionRemove(({ reactionId, messageId }) => {
      setMessageReactions(messageId, (list) => list.filter((r) => r.id !== reactionId));
    });

    const unsubscribePin = onDmPin((event) => {
      const between = [event.sender_id, event.recipient_id].map(String).sort().join();
      if (between === [user.id, chatUser.id].map(String).sort().join()) applyPin(event);
    });

    const unsubscribeLinkPreviews = onDmLinkPreviews(async ({ messageId, link_previews: previews }) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (!msg) return;
      const linkEmbeds = await openDmPreviews(previews, msg.content, msg.plaintext, sharedKey, dmPreviewsContext(msg.id, msg.sender_id, msg.recipient_id));
      updateMessage(messageId, (m) => (m.content === msg.content ? { link_embeds: linkEmbeds } : {}));
    });

    return () => {
      unsubscribeNew();
      unsubscribeLinkPreviews();
      unsubscribeDelete();
      unsubscribeEdit();
      unsubscribeReactionAdd();
      unsubscribeReactionRemove();
      unsubscribePin();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatUser?.id, user?.id, sharedKey]);

  return {
    messages,
    messagesRef,
    hasMore,
    isLoading,
    error,
    sharedKey,
    keyStatus,
    setKeyStatus,
    acceptChangedKey,
    loadMoreMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    setMessageReactions,
    pinsVersion,
    loadPins,
    setPinned,
    loadEdits,
    firstUnread,
  };
}
