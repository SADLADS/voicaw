import { useEffect, useRef, useState } from 'react';

const isAway = () => typeof document !== 'undefined' && (document.visibilityState === 'hidden' || !document.hasFocus());

// Where the chat's "New" divider goes (Discord's red line): the id of the first message to
// draw it above, or null for none. MessageList draws it before the first message with an id
// at least that.
//
// `firstUnread` is the conversation hook's ({ id } or null): where the unread messages started,
// as the server said when opening the chat marked it read. The divider stays there until the
// chat changes, moves to the first message that comes while the window is hidden or in the
// background, and goes when you send one yourself.
export function useNewDivider({ chatId, firstUnread, isLoading, messages, userId }) {
  // `seen`: the `firstUnread` last taken (a new object each time the server says).
  const [state, setState] = useState({ chatId, from: firstUnread?.id ?? null, seen: firstUnread });
  let from = state.from;
  if (state.chatId !== chatId) {
    // Whatever the hook still holds is the last chat's.
    from = null;
    setState({ chatId, from, seen: firstUnread });
  } else if (firstUnread && firstUnread !== state.seen) {
    from = firstUnread.id;
    setState({ chatId, from, seen: firstUnread });
  }

  // Set while the window is hidden or in the background: the next message from someone else
  // moves the divider to it (once per time away).
  const awayRef = useRef(false);
  useEffect(() => {
    const update = () => { awayRef.current = isAway(); };
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  // The newest message seen in this chat, to tell new ones apart from history loading.
  let newest = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Number.isInteger(messages[i].id)) { newest = messages[i]; break; }
  }
  const seenRef = useRef({ chatId: null, newestId: null });
  useEffect(() => {
    const seen = seenRef.current;
    const previous = seen.chatId === chatId ? seen.newestId : null;
    seenRef.current = { chatId, newestId: newest?.id ?? null };
    if (isLoading || previous == null || newest == null || newest.id <= previous) return;
    if (Number(newest.sender_id) === Number(userId)) {
      setState((s) => (s.chatId === chatId && s.from != null ? { ...s, from: null } : s));
    } else if (awayRef.current) {
      awayRef.current = false;
      setState((s) => (s.chatId === chatId ? { ...s, from: newest.id } : s));
    }
  }, [chatId, isLoading, newest, userId]);

  return isLoading ? null : from;
}
