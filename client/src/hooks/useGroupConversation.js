import { useEffect, useMemo, useRef, useState } from 'react';
import { onGroupEvent, setActiveChat } from '../utils/ws-client';
import {
  addGroupReaction,
  deleteGroupMessage,
  editGroupMessage,
  fetchGroupMessages,
  markGroupRead,
  removeGroupReaction,
  sendGroupMessage,
  fetchGroupPins,
  setGroupMessagePinned,
  setGroupLinkPreviews,
  fetchGroupEditHistory,
  fetchGroupMessageRanges,
} from '../services/groupService';
import { searchConversation } from '../services/searchIndex';
import {
  decryptGroupMessage,
  decryptGroupReaction,
  encryptGroupMessage,
  encryptGroupReaction,
  groupMessageContext,
  groupReactionContext,
  messageSignatureContext,
  openGroupName,
  reactionSignatureContext,
} from '../services/groupCrypto';
import { loadIdentityKey } from '../services/keyStore';
import { groupPreviewsContext, groupPreviewsSignatureContext, openGroupPreviews, sealGroupPreviews } from '../services/linkPreviewCrypto';
import { previewsFor } from '../services/linkPreviewService';
import { currentEpoch, openGroup, renameGroup } from '../services/groupKeys';
import { nameOf } from '../utils/profiles';
import { uploadNamesIn } from '../utils/attachmentMarkup';
import { t } from '../i18n';

export const GROUP_PAGE_SIZE = 50;

const UNREADABLE = t('groups.messages.unreadable');
const FORGED = t('groups.messages.forged');

// One group DM: its keys and checked membership (groupKeys.openGroup), history (decrypted with
// each message's epoch key), sending (with the current epoch, making the next one when the
// members changed), edits, deletes, reactions and live updates. The same shape as
// useConversation for ChatPane, plus `group` (openGroup's result: detail, log, problems),
// Everything is signed by its sender (groupCrypto.js) and checked against their identity key
// from the group's checked log: a message whose signature doesn't match isn't shown
// (`unverified`), one from before signing is marked `unsigned`, reactions that don't match are
// dropped.
// `saveReaction` / `deleteReaction`, and `reload()`. Membership changes show in the timeline
// as system rows ({ system: true, text }), renames too (rows from the server, `system`
// 'group_name', with the signed name they set, checked like a message).
// A group whose name is still plaintext (from before names were encrypted) gets it encrypted
// by the first member to open it.
export function useGroupConversation({ groupId, user, onRead }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [group, setGroup] = useState(null);
  // Bumped whenever a message here is pinned or unpinned (the pins list reloads).
  const [pinsVersion, setPinsVersion] = useState(0);
  // Where the unread messages started when the group opened ({ id }; useConversation's).
  const [firstUnread, setFirstUnread] = useState(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const groupRef = useRef(group);
  groupRef.current = group;
  const loadingOlder = useRef(false);
  const activeGroupId = useRef(groupId);
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

  // The group with fresh keys (after a membership change or a new epoch).
  async function reload() {
    const opened = await openGroup(user, groupId);
    if (activeGroupId.current === groupId) setGroup(opened);
    return opened;
  }

  async function keyFor(epoch) {
    let opened = groupRef.current;
    if (!opened?.keys.has(epoch)) opened = await reload();
    return opened.keys.get(epoch) ?? null;
  }

  // The signed context of a stored message (see messageSignatureContext).
  const signatureContextOf = (row) => messageSignatureContext({
    groupId, epoch: row.epoch, senderId: row.sender_id, replyTo: row.parent_message_id ?? null, editOf: row.edited ? row.id : null,
  });

  // -> { plaintext, unsigned?, unverified? }. `verify` false for a reply's preview (whose own
  // signature context the server doesn't send; the message itself is checked where it's shown).
  async function decryptText(content, epoch, senderId, signatureContext, verify = true) {
    const key = await keyFor(epoch);
    if (!key) return { plaintext: UNREADABLE };
    try {
      const identityKey = verify ? groupRef.current?.log.identityKeys.get(senderId) ?? 'unknown' : null;
      const { text, signed, verified } = await decryptGroupMessage(content, key, groupMessageContext(groupId, epoch, senderId), identityKey, signatureContext);
      if (signed && verified === false) return { plaintext: FORGED, unverified: true };
      return { plaintext: text, unsigned: !signed };
    } catch {
      return { plaintext: UNREADABLE };
    }
  }

  // A message's link previews (services/linkPreviewCrypto.js), for its stored `content` and
  // text, if its sender signed them: the embeds to show, or null.
  async function openPreviews(previews, msg, text) {
    if (!previews) return null;
    const at = [groupId, msg.epoch, msg.id, msg.sender_id];
    return openGroupPreviews(
      previews, msg.content, text, await keyFor(msg.epoch), groupPreviewsContext(...at),
      groupRef.current?.log.identityKeys.get(msg.sender_id), groupPreviewsSignatureContext(...at)
    );
  }

  async function decryptReactions(messageId, epoch, reactions) {
    const key = await keyFor(epoch);
    const out = [];
    for (const r of reactions ?? []) {
      try {
        const { emoji, signed, verified } = await decryptGroupReaction(
          r.content, key, groupReactionContext(groupId, messageId, r.user_id),
          groupRef.current?.log.identityKeys.get(r.user_id) ?? 'unknown',
          reactionSignatureContext({ groupId, epoch, messageId, reactorId: r.user_id })
        );
        if (signed && !verified) continue;
        out.push({ id: r.id, user_id: r.user_id, emoji, timestamp: r.timestamp });
      } catch {
        // Skip one that doesn't open.
      }
    }
    return out;
  }

  // A "poll ended" row has no content of its own: its poll (the parent, checked against its
  // author's signature like any message, since its result is shown from it) and the poll's
  // votes (`poll_reactions`, checked too) are what's shown.
  async function decryptPollEndRow(row) {
    const poll = row.parent_content != null ? await decryptText(row.parent_content, row.parent_epoch, row.parent_sender_id, signatureContextOf({
      id: row.parent_message_id, epoch: row.parent_epoch, sender_id: row.parent_sender_id,
      parent_message_id: row.parent_reply_to, edited: row.parent_edited,
    })) : null;
    return {
      ...row,
      plaintext: null,
      parent_plaintext: poll && !poll.unverified && !poll.unsigned ? poll.plaintext : null,
      reactions: await decryptReactions(row.id, row.epoch, row.reactions),
      poll_reactions: row.parent_content != null ? await decryptReactions(row.parent_message_id, row.parent_epoch, row.poll_reactions) : [],
    };
  }

  // A rename: the name it set (`renamedTo`; null if it doesn't check out against its sender),
  // or a new picture (`pictureChange`: 'set' or 'removed').
  async function decryptRenameRow(row) {
    let renamedTo = null;
    let pictureChange = null;
    try {
      const name = await openGroupName(row.content, await keyFor(row.epoch), groupId, row.epoch, (id) => groupRef.current?.log.identityKeys.get(id));
      if (name.renamerId === row.sender_id) {
        if (name.change === 'picture') pictureChange = name.picture ? 'set' : 'removed';
        else renamedTo = name.name;
      }
    } catch {
      // Shown as unreadable.
    }
    return { ...row, plaintext: null, reactions: [], renamedTo, pictureChange };
  }

  async function decryptRow(row) {
    if (row.system === 'poll_end') return decryptPollEndRow(row);
    if (row.system === 'group_name') return decryptRenameRow(row);
    // A call (utils/callLog.js): plaintext from the server, shown as a notice.
    if (row.system === 'call') return { ...row, plaintext: null, reactions: [] };
    const text = await decryptText(row.content, row.epoch, row.sender_id, signatureContextOf(row));
    const readable = text.plaintext !== UNREADABLE && !text.unverified;
    return {
      ...row,
      ...text,
      link_embeds: readable ? await openPreviews(row.link_previews, row, text.plaintext) : null,
      parent_plaintext: row.parent_content
        ? (await decryptText(row.parent_content, row.parent_epoch, row.parent_sender_id, null, false)).plaintext
        : null,
      reactions: await decryptReactions(row.id, row.epoch, row.reactions),
    };
  }

  // `opening`: the read on opening the group, which says where its unread messages started.
  const markRead = async (messageId, { opening = false } = {}) => {
    if (!Number.isInteger(messageId)) return;
    try {
      const requestedFor = groupId;
      const first = await markGroupRead(groupId, messageId);
      if (opening && first != null && activeGroupId.current === requestedFor) setFirstUnread({ id: first });
      onReadRef.current?.();
    } catch (err) {
      console.warn('Failed to mark group as read', err);
    }
  };

  useEffect(() => {
    if (!groupId) return undefined;
    setActiveChat(`group-${groupId}`);
    return () => setActiveChat(null);
  }, [groupId]);

  useEffect(() => {
    activeGroupId.current = groupId;
    loadingOlder.current = false;
    setMessages([]);
    setFirstUnread(null);
    setGroup(null);
    setHasMore(true);
    setError(null);
    if (!groupId || !user?.id) {
      setIsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const opened = await openGroup(user, groupId);
        if (cancelled) return;
        groupRef.current = opened;
        setGroup(opened);
        if (opened.name?.legacy && !opened.problems.length) {
          renameGroup(user, groupId, opened.name.name, { initial: true, opened })
            .catch((err) => console.warn("Failed to encrypt the group's name", err));
        }
        const page = await fetchGroupMessages(groupId, { limit: GROUP_PAGE_SIZE });
        const rows = await Promise.all(page.map(decryptRow));
        if (cancelled) return;
        setMessages(rows);
        setHasMore(page.length >= GROUP_PAGE_SIZE);
        markRead(rows.at(-1)?.id ?? 0, { opening: true });
      } catch (e) {
        if (cancelled) return;
        console.error('Failed to load group:', e);
        setError(e.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, user?.id]);

  const loadMoreMessages = async () => {
    if (loadingOlder.current || !hasMore) return;
    const oldest = messagesRef.current.find((m) => Number.isInteger(m.id));
    if (!oldest) return;
    loadingOlder.current = true;
    const requestedFor = groupId;
    try {
      const page = await fetchGroupMessages(requestedFor, { before: oldest.id, limit: GROUP_PAGE_SIZE });
      const rows = await Promise.all(page.map(decryptRow));
      if (activeGroupId.current !== requestedFor) return;
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = rows.filter((m) => !known.has(m.id));
      if (fresh.length) setMessages((prev) => [...fresh, ...prev]);
      setHasMore(page.length >= GROUP_PAGE_SIZE);
    } catch (e) {
      console.error('Failed to load older messages:', e);
    } finally {
      if (activeGroupId.current === requestedFor) loadingOlder.current = false;
    }
  };

  function addIncoming(message) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      const pending = prev.findIndex((m) => m.status === 'pending' && m.sender_id === message.sender_id && m.plaintext === message.plaintext);
      if (pending !== -1) {
        const updated = [...prev];
        updated[pending] = { ...message, clientKey: prev[pending].clientKey ?? prev[pending].id };
        return updated;
      }
      return [...prev, message];
    });
    if (message.sender_id !== user.id) markRead(message.id);
  }

  // Encrypts with the current epoch (making the next one first if the members changed) and
  // sends. A 409 means the members changed meanwhile: once more with a fresh epoch.
  async function encryptAndSend(text, replyToId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { epoch, key, group: opened } = await currentEpoch(user, groupId, groupRef.current);
      groupRef.current = opened;
      setGroup(opened);
      const content = await encryptGroupMessage(
        text, key, groupMessageContext(groupId, epoch, user.id), await loadIdentityKey(),
        messageSignatureContext({ groupId, epoch, senderId: user.id, replyTo: replyToId })
      );
      try {
        return await sendGroupMessage(groupId, epoch, content, replyToId, uploadNamesIn(text));
      } catch (err) {
        if (err.response?.status !== 409 || attempt === 1) throw err;
        groupRef.current = await reload();
      }
    }
    return null;
  }

  async function sendMessage({ text, replyTo = null, localAttachments = {}, resolveText }) {
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, {
      id: tempId,
      group_id: groupId,
      sender_id: user.id,
      sender_username: user.username,
      plaintext: text,
      status: 'pending',
      timestamp: Math.floor(Date.now() / 1000),
      parent_message_id: replyTo?.id ?? null,
      parent_plaintext: replyTo?.plaintext ?? null,
      parent_sender_id: replyTo?.sender_id ?? null,
      parent_username: replyTo?.sender_username ?? null,
      reactions: [],
      localAttachments,
    }]);
    try {
      const finalText = resolveText ? await resolveText() : text;
      if (finalText !== text) updateMessage(tempId, () => ({ plaintext: finalText }));
      const saved = { ...(await encryptAndSend(finalText, replyTo?.id ?? null)), plaintext: finalText, reactions: [] };
      saved.parent_plaintext = replyTo?.plaintext ?? null;
      setMessages((prev) => {
        if (prev.some((m) => m.id === saved.id)) return prev.filter((m) => m.id !== tempId);
        return prev.map((m) => (m.id === tempId ? { ...saved, clientKey: tempId, localAttachments, status: 'sent' } : m));
      });
      attachLinkPreviews(saved, saved.content, finalText);
      return saved;
    } catch (err) {
      console.error('Error sending message:', err);
      updateMessage(tempId, () => ({ status: 'failed' }));
      throw err;
    }
  }

  async function editMessage(messageId, text) {
    const original = messagesRef.current.find((m) => m.id === messageId);
    const key = await keyFor(original.epoch);
    const context = messageSignatureContext({
      groupId, epoch: original.epoch, senderId: user.id, replyTo: original.parent_message_id ?? null, editOf: messageId,
    });
    const content = await encryptGroupMessage(text, key, groupMessageContext(groupId, original.epoch, user.id), await loadIdentityKey(), context);
    await editGroupMessage(messageId, content, uploadNamesIn(text));
    // An edit clears the previews (the server too); this device makes them again.
    updateMessage(messageId, () => ({ plaintext: text, content, edited: 1, link_embeds: null }));
    attachLinkPreviews(original, content, text);
  }

  // Makes and stores the link previews for this device's message `msg` (stored as `content`),
  // if it can (services/linkPreviewService.js). Not awaited: the message is already sent.
  async function attachLinkPreviews(msg, content, text) {
    try {
      const embeds = await previewsFor(text);
      if (!embeds.length) return;
      const at = [groupId, msg.epoch, msg.id, user.id];
      const previews = await sealGroupPreviews(
        embeds, content, await keyFor(msg.epoch), groupPreviewsContext(...at), await loadIdentityKey(), groupPreviewsSignatureContext(...at)
      );
      if (!previews) return;
      await setGroupLinkPreviews(msg.id, previews);
      const linkEmbeds = await openPreviews(previews, { ...msg, content }, text);
      updateMessage(msg.id, (m) => (m.content === content ? { link_embeds: linkEmbeds } : {}));
    } catch (err) {
      console.warn('Could not add link previews', err?.message);
    }
  }

  async function deleteMessage(messageId) {
    await deleteGroupMessage(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }

  // The pinned messages you can read, decrypted and checked, most recently pinned first.
  async function loadPins() {
    return Promise.all((await fetchGroupPins(groupId)).map(decryptRow));
  }

  // Searches the group on this device (services/searchIndex.js), as useConversation's. Only
  // messages that open and whose signature checks out are kept (unsigned old ones too, marked).
  function searchMessages(params, options) {
    return searchConversation({
      key: `${user.id}/group/${groupId}`,
      fetchPage: (before, limit) => fetchGroupMessages(groupId, before == null ? { limit } : { before, limit }),
      toEntries: async (rows) => (await Promise.all(rows.filter((r) => !r.system).map(async (r) => {
        const text = await decryptText(r.content, r.epoch, r.sender_id, signatureContextOf(r));
        if (text.plaintext === UNREADABLE || text.unverified) return null;
        return { i: r.id, s: r.sender_id, t: r.timestamp, p: text.plaintext, ...(text.unsigned ? { u: 1 } : {}) };
      }))).filter(Boolean),
      fetchRanges: (ranges) => fetchGroupMessageRanges(groupId, ranges),
    }, params, options);
  }

  // A message's earlier versions (EditHistoryDialog), decrypted and checked like the message:
  // { versions: [{ plaintext, unsigned?, unverified?, written_at, edited }], edited_at }. Each
  // was signed as an edit of it or not (`edited`).
  async function loadEdits(msg) {
    const { versions, edited_at } = await fetchGroupEditHistory(msg.id);
    return {
      versions: await Promise.all(versions.map(async (v) => ({
        ...v,
        ...await decryptText(v.content, msg.epoch, msg.sender_id, signatureContextOf({ ...msg, edited: v.edited })),
      }))),
      edited_at,
    };
  }

  async function setPinned(msg, pinned) {
    applyPin(await setGroupMessagePinned(msg.id, pinned));
  }

  async function saveReaction(msg, emoji) {
    const key = await keyFor(msg.epoch);
    return addGroupReaction(msg.id, await encryptGroupReaction(
      emoji, key, groupReactionContext(groupId, msg.id, user.id), await loadIdentityKey(),
      reactionSignatureContext({ groupId, epoch: msg.epoch, messageId: msg.id, reactorId: user.id })
    ));
  }

  useEffect(() => {
    if (!groupId || !user?.id) return undefined;
    return onGroupEvent(async (event) => {
      if (event.groupId !== groupId && event.group?.id !== groupId) return;
      switch (event.type) {
        case 'group_dm_message_new':
          addIncoming(await decryptRow(event.message));
          break;
        case 'group_dm_message_edit': {
          const original = messagesRef.current.find((m) => m.id === event.messageId);
          if (!original) break;
          const text = await decryptText(event.content, original.epoch, original.sender_id, signatureContextOf({ ...original, edited: 1 }));
          updateMessage(event.messageId, () => ({ ...text, content: event.content, edited: 1, link_embeds: null }));
          break;
        }
        case 'group_dm_message_link_previews': {
          const msg = messagesRef.current.find((m) => m.id === event.messageId);
          if (!msg || msg.plaintext == null || msg.plaintext === UNREADABLE || msg.unverified) break;
          const linkEmbeds = await openPreviews(event.link_previews, msg, msg.plaintext);
          updateMessage(event.messageId, (m) => (m.content === msg.content ? { link_embeds: linkEmbeds } : {}));
          break;
        }
        case 'group_dm_message_delete':
          setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        case 'group_dm_reaction_add': {
          const msg = messagesRef.current.find((m) => m.id === event.reaction.message_id);
          if (!msg) break;
          const [reaction] = await decryptReactions(msg.id, msg.epoch, [event.reaction]);
          if (reaction) setMessageReactions(msg.id, (list) => (list.some((r) => r.id === reaction.id) ? list : [...list, reaction]));
          break;
        }
        case 'group_dm_message_pin':
          applyPin(event);
          break;
        case 'group_dm_reaction_remove':
          setMessageReactions(event.messageId, (list) => list.filter((r) => r.id !== event.reactionId));
          break;
        case 'group_dm_epoch':
        case 'group_dm_update':
          reload().catch((err) => console.warn('Failed to reload the group', err));
          break;
        default:
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, user?.id]);

  // Membership changes in the timeline, from the time you were first in the group.
  const display = useMemo(() => {
    if (!group) return messages;
    const names = new Map(group.detail.users.map((u) => [u.id, nameOf(u)]));
    const isMe = (id) => id === user.id;
    const name = (id) => names.get(id) ?? t('groups.log.someone');
    const logText = (r) => {
      const actor = name(r.actor);
      const target = name(r.target);
      if (r.type === 'create') return isMe(r.actor) ? t('groups.log.youCreated') : t('groups.log.created', { actor });
      if (r.type === 'add') {
        if (isMe(r.actor)) return t('groups.log.youAdded', { target });
        return isMe(r.target) ? t('groups.log.addedYou', { actor }) : t('groups.log.added', { actor, target });
      }
      if (r.type === 'remove') {
        if (isMe(r.actor)) return t('groups.log.youRemoved', { target });
        return isMe(r.target) ? t('groups.log.removedYou', { actor }) : t('groups.log.removed', { actor, target });
      }
      return isMe(r.actor) ? t('groups.log.youLeft') : t('groups.log.left', { actor });
    };
    const renameText = (m) => {
      const actor = name(m.sender_id);
      if (m.pictureChange === 'set') return isMe(m.sender_id) ? t('groups.log.youChangedPicture') : t('groups.log.changedPicture', { actor });
      if (m.pictureChange === 'removed') return isMe(m.sender_id) ? t('groups.log.youRemovedPicture') : t('groups.log.removedPicture', { actor });
      if (m.renamedTo == null) return isMe(m.sender_id) ? t('groups.log.youRenamedUnchecked') : t('groups.log.renamedUnchecked', { actor });
      if (m.renamedTo) return isMe(m.sender_id) ? t('groups.log.youRenamed', { name: m.renamedTo }) : t('groups.log.renamed', { actor, name: m.renamedTo });
      return isMe(m.sender_id) ? t('groups.log.youRemovedName') : t('groups.log.removedName', { actor });
    };
    const records = group.log.records;
    const firstIn = records.findIndex((r) => (r.type === 'create' ? r.actor : r.target) === user.id && (r.type === 'create' || r.type === 'add'));
    const oldestShown = messages.find((m) => Number.isInteger(m.id))?.timestamp ?? 0;
    const rows = records.slice(Math.max(firstIn, 0))
      .filter((r) => !hasMore || r.at >= oldestShown)
      .map((r) => ({
        id: `log-${r.seq}`,
        system: true,
        timestamp: r.at,
        text: logText(r),
      }));
    const shown = messages.map((m) => (m.system === 'group_name' ? {
      ...m,
      text: renameText(m),
    } : m));
    // Merged by time; messages keep their order.
    const out = [];
    let i = 0;
    for (const m of shown) {
      while (i < rows.length && rows[i].timestamp <= (m.timestamp ?? Infinity)) out.push(rows[i++]);
      out.push(m);
    }
    return [...out, ...rows.slice(i)];
  }, [group, messages, hasMore, user?.id]);

  return {
    messages: display,
    messagesRef,
    firstUnread,
    hasMore,
    isLoading,
    error,
    loadMoreMessages,
    sendMessage,
    editMessage,
    deleteMessage,
    setMessageReactions,
    saveReaction,
    deleteReaction: removeGroupReaction,
    group,
    reload,
    pinsVersion,
    loadPins,
    setPinned,
    loadEdits,
    searchMessages,
  };
}
