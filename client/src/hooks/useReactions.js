import { useEffect, useRef, useState } from 'react';
import {
  answerKey,
  answerProblem,
  cleanAnswer,
  newOptionId,
  parsePoll,
  planVotes,
  pollWithAnswers,
  removalKey,
  voteKey,
} from '../utils/pollMarkup';
import { t } from '../i18n';

// Reacting to messages in a conversation (useConversation) or channel (useChannel): adding and
// removing your own reactions, and which message the reaction picker is open for.
// `saveReaction(msg, emoji)` stores one (resolving to its `{ id }`) and `deleteReaction(id)`
// removes one: that's where a DM encrypts and a guild doesn't. Nothing is sent until `ready`.
// `onError(message)` reports failures. The picker closes when the chat (`chatId`) changes.
// Poll votes are reactions too (utils/pollMarkup.js): `vote(msg, optionIds)`, and so are the
// answers people add to open polls: `addAnswer` and `removeAnswer`. In a guild,
// `removePollAnswer(msg, optionId)` has the server remove one (resolving to the ids of the
// reactions it deleted); elsewhere its creator deletes their reaction and the poll's author
// adds a removal.
export function useReactions({ chatId, user, ready, saveReaction, deleteReaction, removePollAnswer, messagesRef, setMessageReactions, onError }) {
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

  // Saves your reaction `emoji` on `msg` (adding it to the message's list), resolving to it.
  async function addOwn(msg, emoji) {
    const saved = await saveReaction(msg, emoji);
    const reaction = { id: saved.id, user_id: user.id, emoji, timestamp: saved.timestamp };
    // The websocket may have delivered it already.
    setMessageReactions(msg.id, (list) => (list.some((r) => r.id === saved.id) ? list : [...list, reaction]));
    return reaction;
  }

  // Deletes your reactions `ids` on the message `messageId`.
  async function deleteOwn(messageId, ids) {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => deleteReaction(id)));
    const removed = new Set(ids);
    setMessageReactions(messageId, (list) => list.filter((r) => !removed.has(r.id)));
  }

  // Makes your votes in the poll `msg` (whose reactions are `reactions`) exactly `optionIds`.
  async function setVotes(msg, reactions, optionIds) {
    const poll = parsePoll(msg.plaintext);
    if (!poll) return;
    const { remove, add } = planVotes(pollWithAnswers(poll, reactions, msg.sender_id), reactions, user.id, optionIds);
    await deleteOwn(msg.id, remove.map((r) => r.id));
    for (const optionId of add) await addOwn(msg, voteKey(optionId));
  }

  // Runs `work(the message as it is now)` for the poll `msg`, one at a time per poll. A failure
  // is reported (the server's error, the thrown one's, or `failedKey`'s) and rejects.
  async function pollAction(msg, failedKey, work) {
    const key = `${msg.id}|poll`;
    if (!ready || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    try {
      return await work(messagesRef.current.find((m) => m.id === msg.id) ?? msg);
    } catch (err) {
      console.error('Failed to update the poll', err);
      onError(err.response?.data?.error || err.message || t(failedKey));
      throw err;
    } finally {
      inFlight.current.delete(key);
    }
  }

  // Sets your vote in the poll `msg` is to exactly `optionIds` ([]: removes it; see planVotes).
  // Resolves once saved (rejects if it couldn't be, after reporting it).
  function vote(msg, optionIds) {
    return pollAction(msg, 'chat.poll.voteFailed', (current) => setVotes(current, current.reactions ?? [], optionIds));
  }

  // Adds answer `text` to the open poll `msg`, resolving to its id. It isn't voted for: Poll.jsx
  // ticks it, for you to send with Vote.
  function addAnswer(msg, text) {
    return pollAction(msg, 'chat.poll.addAnswerFailed', async (current) => {
      const poll = parsePoll(current.plaintext);
      if (!poll?.open) return null;
      const reactions = current.reactions ?? [];
      const problem = answerProblem(pollWithAnswers(poll, reactions, current.sender_id), text);
      if (problem) throw new Error(problem);
      const id = newOptionId();
      await addOwn(current, answerKey({ id, round: poll.round, text: cleanAnswer(text) }));
      return id;
    });
  }

  // Removes the added answer `option` (pollWithAnswers') from the poll `msg`, and your votes
  // for it.
  function removeAnswer(msg, option) {
    return pollAction(msg, 'chat.poll.removeAnswerFailed', async (current) => {
      if (removePollAnswer) {
        const removed = new Set(await removePollAnswer(current, option.id));
        setMessageReactions(current.id, (list) => list.filter((r) => !removed.has(r.id)));
        return;
      }
      const myVotes = (current.reactions ?? []).filter((r) => r.user_id === user.id && r.emoji === voteKey(option.id));
      if (option.addedBy === user.id) {
        await deleteOwn(current.id, [...option.reactionIds, ...myVotes.map((r) => r.id)]);
      } else {
        await addOwn(current, removalKey(option.id));
        await deleteOwn(current.id, myVotes.map((r) => r.id));
      }
    });
  }

  return { reactingTo, openPicker, closePicker, toggleReaction, pickReaction, vote, addAnswer, removeAnswer };
}
