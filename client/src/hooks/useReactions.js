import { useEffect, useRef, useState } from 'react';
import { parsePoll, planVotes, voteKey } from '../utils/pollMarkup';
import { t } from '../i18n';

// Reacting to messages in a conversation (useConversation) or channel (useChannel): adding and
// removing your own reactions, and which message the reaction picker is open for.
// `saveReaction(msg, emoji)` stores one (resolving to its `{ id }`) and `deleteReaction(id)`
// removes one: that's where a DM encrypts and a guild doesn't. Nothing is sent until `ready`.
// `onError(message)` reports failures. The picker closes when the chat (`chatId`) changes.
// Poll votes are reactions too (utils/pollMarkup.js): `vote(msg, optionIds)`.
export function useReactions({ chatId, user, ready, saveReaction, deleteReaction, messagesRef, setMessageReactions, onError }) {
  // The message the picker is choosing a reaction for, and (desktop) the rect of the button
  // that opened it, to show it next to.
  const [reactingTo, setReactingTo] = useState(null);
  // Reactions being added or removed ("<messageId>|<emoji>"), so a double tap doesn't do it twice.
  const inFlight = useRef(new Set());

  useEffect(() => () => setReactingTo(null), [chatId]);

  // Opens the picker for `msg` next to `anchor` (again for the same message closes it).
  function openPicker(msg, anchor) {
    if (reactingTo?.msgId === msg.id) {
      setReactingTo(null);
      return;
    }
    const rect = anchor?.getBoundingClientRect();
    setReactingTo({ msgId: msg.id, rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } });
  }

  const closePicker = () => setReactingTo(null);

  // Adds `emoji` to `msg` as a reaction from this user, or removes it if they already have.
  async function toggleReaction(msg, emoji) {
    const key = `${msg.id}|${emoji}`;
    if (!ready || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      const current = messagesRef.current.find((m) => m.id === msg.id) ?? msg;
      const mine = (current.reactions ?? []).filter((r) => r.user_id === user.id && r.emoji === emoji);
      if (mine.length > 0) {
        await Promise.all(mine.map((r) => deleteReaction(r.id)));
        const removed = new Set(mine.map((r) => r.id));
        setMessageReactions(msg.id, (list) => list.filter((r) => !removed.has(r.id)));
      } else {
        const saved = await saveReaction(msg, emoji);
        // The websocket may have delivered it already.
        setMessageReactions(msg.id, (list) =>
          list.some((r) => r.id === saved.id) ? list : [...list, { id: saved.id, user_id: user.id, emoji, timestamp: saved.timestamp }]
        );
      }
    } catch (err) {
      console.error('Failed to update reaction', err);
      onError(err.response?.data?.error || t('chat.reactions.updateFailed'));
    } finally {
      inFlight.current.delete(key);
    }
  }

  // An emoji picked in the picker. Picking one you've already reacted with leaves it as is
  // (tapping its chip removes it).
  function pickReaction(emoji) {
    const msg = messagesRef.current.find((m) => m.id === reactingTo?.msgId);
    if (!msg) return;
    const alreadyMine = (msg.reactions ?? []).some((r) => r.user_id === user.id && r.emoji === emoji);
    if (!alreadyMine) toggleReaction(msg, emoji);
  }

  // Sets your vote in the poll `msg` is to exactly `optionIds` ([]: removes it; see planVotes).
  // Resolves once saved (rejects if it couldn't be, after reporting it).
  async function vote(msg, optionIds) {
    const key = `${msg.id}|poll`;
    if (!ready || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      const current = messagesRef.current.find((m) => m.id === msg.id) ?? msg;
      const poll = parsePoll(current.plaintext);
      if (!poll) return;
      const { remove, add } = planVotes(poll, current.reactions, user.id, optionIds);
      if (remove.length > 0) {
        await Promise.all(remove.map((r) => deleteReaction(r.id)));
        const removed = new Set(remove.map((r) => r.id));
        setMessageReactions(msg.id, (list) => list.filter((r) => !removed.has(r.id)));
      }
      for (const optionId of add) {
        const emoji = voteKey(optionId);
        const saved = await saveReaction(current, emoji);
        setMessageReactions(msg.id, (list) =>
          list.some((r) => r.id === saved.id) ? list : [...list, { id: saved.id, user_id: user.id, emoji, timestamp: saved.timestamp }]
        );
      }
    } catch (err) {
      console.error('Failed to vote', err);
      onError(err.response?.data?.error || t('chat.poll.voteFailed'));
      throw err;
    } finally {
      inFlight.current.delete(key);
    }
  }

  return { reactingTo, openPicker, closePicker, toggleReaction, pickReaction, vote };
}
