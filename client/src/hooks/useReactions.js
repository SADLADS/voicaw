import { useEffect, useRef, useState } from 'react';
import { addReaction, removeReaction } from '../services/dmService';
import { encryptReaction, reactionContext } from '../services/encryptionService';

// Reacting to messages in a conversation (see useConversation): adding and removing your own
// reactions, and which message the reaction picker is open for. `onError(message)` reports
// failures. The picker closes when the conversation (`chatId`) changes.
export function useReactions({ chatId, user, sharedKey, messagesRef, setMessageReactions, onError }) {
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
    if (!sharedKey || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      const current = messagesRef.current.find((m) => m.id === msg.id) ?? msg;
      const mine = (current.reactions ?? []).filter((r) => r.user_id === user.id && r.emoji === emoji);
      if (mine.length > 0) {
        await Promise.all(mine.map((r) => removeReaction(r.id)));
        const removed = new Set(mine.map((r) => r.id));
        setMessageReactions(msg.id, (list) => list.filter((r) => !removed.has(r.id)));
      } else {
        const content = await encryptReaction(
          emoji, sharedKey, reactionContext(msg.id, user.id, msg.sender_id, msg.recipient_id)
        );
        const saved = await addReaction(msg.id, content);
        // The websocket may have delivered it already.
        setMessageReactions(msg.id, (list) =>
          list.some((r) => r.id === saved.id) ? list : [...list, { id: saved.id, user_id: user.id, emoji }]
        );
      }
    } catch (err) {
      console.error('Failed to update reaction', err);
      onError(err.response?.data?.error || "Couldn't update the reaction. Try again.");
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

  return { reactingTo, openPicker, closePicker, toggleReaction, pickReaction };
}
